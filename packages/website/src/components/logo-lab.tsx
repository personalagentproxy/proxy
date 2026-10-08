'use client';

import {Canvas, useFrame} from '@react-three/fiber';
import {Environment, Lightformer, OrbitControls, PerspectiveCamera} from '@react-three/drei';
import * as THREE from 'three';
import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

type Shape = 'hyperboloid' | 'catenoid' | 'power' | 'trumpet';
type RenderMode = 'solid' | 'wireframe' | 'grid';
type Axis = 'none' | 'x' | 'y' | 'z';

type Light = {azimuth: number; elevation: number; intensity: number; color: string};

type Params = {
	// Shape
	shape: Shape;
	throat: number;
	mouth: number;
	length: number;
	power: number;
	lip: number;
	rings: number;
	segments: number;
	flat: boolean;
	// Render
	render: RenderMode;
	gridRingEvery: number;
	gridMeridians: number;
	unlit: boolean;
	color: string;
	innerColor: string;
	sameInner: boolean;
	metalness: number;
	roughness: number;
	clearcoat: number;
	iridescence: number;
	transmission: number;
	opacity: number;
	// Rotation
	rotX: number;
	rotY: number;
	rotZ: number;
	turn: number;
	spinAxis: Axis;
	spinSpeed: number;
	// Lighting
	key: Light;
	fill: Light;
	rim: Light;
	ambient: number;
	studio: boolean;
	studioIntensity: number;
	// Scene
	background: string;
	transparent: boolean;
	fov: number;
};

const DEFAULTS: Params = {
	shape: 'hyperboloid',
	throat: 0.3,
	mouth: 1.2,
	length: 3,
	power: 2,
	lip: 0,
	rings: 64,
	segments: 96,
	flat: false,

	render: 'solid',
	gridRingEvery: 4,
	gridMeridians: 24,
	unlit: false,
	color: '#d8d8dc',
	innerColor: '#2a2a30',
	sameInner: true,
	metalness: 0.9,
	roughness: 0.25,
	clearcoat: 0,
	iridescence: 0,
	transmission: 0,
	opacity: 1,

	rotX: 20,
	rotY: 0,
	rotZ: 25,
	turn: 0,
	spinAxis: 'none',
	spinSpeed: 0.5,

	key: {azimuth: 40, elevation: 45, intensity: 3, color: '#ffffff'},
	fill: {azimuth: -60, elevation: 10, intensity: 0.8, color: '#dbe6ff'},
	rim: {azimuth: 160, elevation: 30, intensity: 2, color: '#ffffff'},
	ambient: 0.2,
	studio: true,
	studioIntensity: 1,

	background: '#0b0b0d',
	transparent: false,
	fov: 35,
};

// A few starting points matching the directions worth trying.
const PRESETS: Record<string, Partial<Params>> = {
	'Chrome throat': {},
	'Low-poly facets': {
		rings: 10,
		segments: 14,
		flat: true,
		metalness: 0.2,
		roughness: 0.5,
		color: '#e8e8ee',
		studio: true,
	},
	'Blueprint grid': {
		render: 'grid',
		shape: 'catenoid',
		gridRingEvery: 4,
		gridMeridians: 32,
		color: '#8fb4ff',
		background: '#07101f',
	},
	'Ink silhouette': {
		unlit: true,
		color: '#111111',
		background: '#ffffff',
		rotX: 0,
		rotZ: 90,
		spinAxis: 'none',
	},
	Glass: {
		transmission: 1,
		roughness: 0.05,
		metalness: 0,
		color: '#ffffff',
		opacity: 1,
		studio: true,
		studioIntensity: 1.5,
	},
	'Two-tone rim': {
		shape: 'trumpet',
		power: 2.5,
		lip: 0.12,
		sameInner: false,
		color: '#f0f0f0',
		innerColor: '#ff5a1f',
		metalness: 0.1,
		roughness: 0.4,
	},
	Iridescent: {
		iridescence: 1,
		metalness: 1,
		roughness: 0.15,
		color: '#9a9aa5',
	},
};

// ---------------------------------------------------------------------------------------------
// Geometry: a surface of revolution of a profile r(t), t from -1 (bottom mouth) to 1 (top mouth)
// ---------------------------------------------------------------------------------------------

function radiusAt(p: Params, t: number): number {
	const u = Math.abs(t);
	const a = p.throat;
	const b = Math.max(p.mouth, a + 0.001);

	if (p.shape === 'hyperboloid') {
		return Math.sqrt(a * a + (b * b - a * a) * u * u);
	}

	if (p.shape === 'catenoid') {
		const k = Math.acosh(b / a);
		return a * Math.cosh(k * u);
	}

	if (p.shape === 'power') {
		return a + (b - a) * Math.pow(u, p.power);
	}

	// trumpet
	const k = p.power * 2;
	return a + ((b - a) * (Math.exp(k * u) - 1)) / (Math.exp(k) - 1);
}

function profile(p: Params): THREE.Vector2[] {
	const half = p.length / 2;
	const body: THREE.Vector2[] = [];
	for (let i = 0; i <= p.rings; i++) {
		const t = -1 + (2 * i) / p.rings;
		body.push(new THREE.Vector2(radiusAt(p, t), t * half));
	}

	if (p.lip <= 0) {
		return body;
	}

	// A rolled rim at each mouth: a half circle curling outwards and back.
	const rEnd = radiusAt(p, 1);
	const steps = 12;
	const bottom: THREE.Vector2[] = [];
	const top: THREE.Vector2[] = [];
	for (let i = 0; i <= steps; i++) {
		const th = (Math.PI * i) / steps;
		const x = rEnd + p.lip - p.lip * Math.cos(th);
		top.push(new THREE.Vector2(x, half + p.lip * Math.sin(th)));
		bottom.push(new THREE.Vector2(x, -half - p.lip * Math.sin(th)));
	}
	bottom.reverse();
	return [...bottom, ...body, ...top];
}

function useLathe(p: Params) {
	return useMemo(() => {
		const pts = profile(p);
		const geometry = new THREE.LatheGeometry(pts, p.segments);
		if (p.flat) {
			return geometry.toNonIndexed();
		}
		return geometry;
	}, [p.shape, p.throat, p.mouth, p.length, p.power, p.lip, p.rings, p.segments, p.flat]);
}

// Rings and meridians as line segments, the embedding-diagram look.
function useGrid(p: Params) {
	return useMemo(() => {
		const pts = profile(p);
		const positions: number[] = [];
		const seg = p.segments;

		const push = (r: number, y: number, phi: number) => {
			positions.push(r * Math.sin(phi), y, r * Math.cos(phi));
		};

		for (let i = 0; i < pts.length; i += p.gridRingEvery) {
			const pt = pts[i];
			if (!pt) {
				continue;
			}
			for (let j = 0; j < seg; j++) {
				push(pt.x, pt.y, (2 * Math.PI * j) / seg);
				push(pt.x, pt.y, (2 * Math.PI * (j + 1)) / seg);
			}
		}

		for (let j = 0; j < p.gridMeridians; j++) {
			const phi = (2 * Math.PI * j) / p.gridMeridians;
			for (let i = 0; i < pts.length - 1; i++) {
				const a = pts[i];
				const b = pts[i + 1];
				if (!a || !b) {
					continue;
				}
				push(a.x, a.y, phi);
				push(b.x, b.y, phi);
			}
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		return geometry;
	}, [
		p.shape,
		p.throat,
		p.mouth,
		p.length,
		p.power,
		p.lip,
		p.rings,
		p.segments,
		p.gridRingEvery,
		p.gridMeridians,
	]);
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;

function lightPosition(l: Light): [number, number, number] {
	const d = 6;
	const el = l.elevation * DEG;
	const az = l.azimuth * DEG;
	return [d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az)];
}

function Spinner({axis, speed, children}: {axis: Axis; speed: number; children: ReactNode}) {
	const ref = useRef<THREE.Group>(null);
	useFrame((_, delta) => {
		if (!ref.current || axis === 'none') {
			return;
		}
		ref.current.rotation[axis] += delta * speed;
	});
	return <group ref={ref}>{children}</group>;
}

function Wormhole({p}: {p: Params}) {
	const lathe = useLathe(p);
	const grid = useGrid(p);

	if (p.render === 'grid') {
		return (
			<lineSegments geometry={grid}>
				<lineBasicMaterial color={p.color} transparent opacity={p.opacity} />
			</lineSegments>
		);
	}

	const wire = p.render === 'wireframe';

	if (p.unlit) {
		return (
			<mesh geometry={lathe}>
				<meshBasicMaterial
					color={p.color}
					side={THREE.DoubleSide}
					wireframe={wire}
					transparent={p.opacity < 1}
					opacity={p.opacity}
				/>
			</mesh>
		);
	}

	const material = (color: string, side: THREE.Side) => (
		<meshPhysicalMaterial
			color={color}
			side={side}
			wireframe={wire}
			flatShading={p.flat}
			metalness={p.metalness}
			roughness={p.roughness}
			clearcoat={p.clearcoat}
			clearcoatRoughness={0.1}
			iridescence={p.iridescence}
			iridescenceIOR={1.6}
			transmission={p.transmission}
			thickness={0.4}
			ior={1.5}
			transparent={p.opacity < 1}
			opacity={p.opacity}
		/>
	);

	if (p.sameInner) {
		return <mesh geometry={lathe}>{material(p.color, THREE.DoubleSide)}</mesh>;
	}

	return (
		<group>
			<mesh geometry={lathe}>{material(p.color, THREE.FrontSide)}</mesh>
			<mesh geometry={lathe}>{material(p.innerColor, THREE.BackSide)}</mesh>
		</group>
	);
}

function Scene({p}: {p: Params}) {
	return (
		<>
			<PerspectiveCamera makeDefault fov={p.fov} position={[0, 0, 7]} />
			<OrbitControls makeDefault enablePan={false} />

			<ambientLight intensity={p.ambient} />
			<directionalLight
				position={lightPosition(p.key)}
				intensity={p.key.intensity}
				color={p.key.color}
			/>
			<directionalLight
				position={lightPosition(p.fill)}
				intensity={p.fill.intensity}
				color={p.fill.color}
			/>
			<directionalLight
				position={lightPosition(p.rim)}
				intensity={p.rim.intensity}
				color={p.rim.color}
			/>

			{p.studio && (
				<Environment resolution={256} environmentIntensity={p.studioIntensity}>
					<Lightformer form="rect" intensity={4} position={[0, 5, -3]} scale={[8, 3, 1]} />
					<Lightformer
						form="rect"
						intensity={2}
						position={[-5, 1, 3]}
						rotation-y={Math.PI / 2}
						scale={[4, 2, 1]}
					/>
					<Lightformer
						form="rect"
						intensity={1}
						position={[5, -1, 2]}
						rotation-y={-Math.PI / 2}
						scale={[4, 1, 1]}
					/>
					<Lightformer form="ring" intensity={1.5} position={[0, 2, 6]} scale={3} />
				</Environment>
			)}

			<group rotation-y={p.turn * DEG}>
				<group rotation={[p.rotX * DEG, p.rotY * DEG, p.rotZ * DEG]}>
					<Spinner axis={p.spinAxis} speed={p.spinSpeed}>
						<Wormhole p={p} />
					</Spinner>
				</group>
			</group>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

function Section({title, children}: {title: string; children: ReactNode}) {
	return (
		<section className="grid gap-2 border-t border-border py-4 first:border-t-0">
			<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
			<div className="grid gap-2">{children}</div>
		</section>
	);
}

function Range({
	label,
	value,
	min,
	max,
	step = 0.01,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (v: number) => void;
}) {
	// What is being typed, so "0." survives until it is a number. Dropped when the field is left
	// or the value changes from elsewhere (the slider, undo, a preset).
	const [draft, setDraft] = useState<string | null>(null);
	const sent = useRef<number | null>(null);
	const type = (text: string) => {
		setDraft(text);
		const n = Number(text);
		if (text.trim() === '' || !Number.isFinite(n)) {
			return;
		}
		sent.current = n;
		onChange(n);
	};
	const shown = draft !== null && sent.current === value ? draft : Number(value.toFixed(3));
	return (
		<label className="grid grid-cols-[6rem_1fr_3.5rem] items-center gap-2 text-sm">
			<span className="truncate">{label}</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-full accent-foreground"
			/>
			<input
				type="number"
				step={step}
				value={shown}
				onChange={(e) => type(e.target.value)}
				onBlur={() => setDraft(null)}
				className="h-7 w-full rounded border border-border bg-transparent px-1 text-right text-sm tabular-nums text-muted-foreground focus:text-foreground"
			/>
		</label>
	);
}

function Color({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<label className="grid grid-cols-[6rem_1fr] items-center gap-2 text-sm">
			<span>{label}</span>
			<span className="flex items-center gap-2">
				<input
					type="color"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
				/>
				<span className="text-muted-foreground tabular-nums">{value}</span>
			</span>
		</label>
	);
}

function Check({
	label,
	value,
	onChange,
}: {
	label: string;
	value: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={value}
				onChange={(e) => onChange(e.target.checked)}
				className="accent-foreground"
			/>
			<span>{label}</span>
		</label>
	);
}

function Choice<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly T[];
	onChange: (v: T) => void;
}) {
	return (
		<label className="grid grid-cols-[6rem_1fr] items-center gap-2 text-sm">
			<span>{label}</span>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
				className="h-8 rounded-md border border-border bg-background px-2 text-sm"
			>
				{options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
			</select>
		</label>
	);
}

function LightControls({
	name,
	light,
	onChange,
}: {
	name: string;
	light: Light;
	onChange: (l: Light) => void;
}) {
	const set = <K extends keyof Light>(k: K, v: Light[K]) => onChange({...light, [k]: v});
	return (
		<div className="grid gap-1 rounded-md border border-border p-2">
			<div className="text-sm font-medium">{name}</div>
			<Range
				label="Azimuth"
				value={light.azimuth}
				min={-180}
				max={180}
				step={1}
				onChange={(v) => set('azimuth', v)}
			/>
			<Range
				label="Elevation"
				value={light.elevation}
				min={-90}
				max={90}
				step={1}
				onChange={(v) => set('elevation', v)}
			/>
			<Range
				label="Intensity"
				value={light.intensity}
				min={0}
				max={8}
				step={0.05}
				onChange={(v) => set('intensity', v)}
			/>
			<Color label="Colour" value={light.color} onChange={(v) => set('color', v)} />
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// History: Cmd+Z undoes, Cmd+Shift+Z redoes. A slider drag arrives as a burst of changes; changes
// less than 400ms apart are one step.
// ---------------------------------------------------------------------------------------------

const BURST_MS = 400;
const HISTORY_MAX = 200;

function useHistory(initial: () => Params) {
	const [p, setPresent] = useState<Params>(initial);
	const present = useRef<Params | null>(null);
	if (present.current === null) {
		present.current = p;
	}
	const past = useRef<Params[]>([]);
	const future = useRef<Params[]>([]);
	const lastChange = useRef(0);

	const commit = useCallback((value: Params) => {
		present.current = value;
		setPresent(value);
	}, []);

	const update = useCallback(
		(next: Params | ((prev: Params) => Params)) => {
			const prev = present.current ?? p;
			const value = typeof next === 'function' ? next(prev) : next;
			const now = Date.now();
			if (now - lastChange.current > BURST_MS) {
				past.current.push(prev);
				if (past.current.length > HISTORY_MAX) {
					past.current.shift();
				}
			}
			lastChange.current = now;
			future.current = [];
			commit(value);
		},
		[commit, p],
	);

	const undo = useCallback(() => {
		const prev = past.current.pop();
		if (!prev || present.current === null) {
			return;
		}
		future.current.push(present.current);
		lastChange.current = 0;
		commit(prev);
	}, [commit]);

	const redo = useCallback(() => {
		const next = future.current.pop();
		if (!next || present.current === null) {
			return;
		}
		past.current.push(present.current);
		lastChange.current = 0;
		commit(next);
	}, [commit]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') {
				return;
			}
			e.preventDefault();
			if (e.shiftKey) {
				redo();
				return;
			}
			undo();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [undo, redo]);

	return {p, update, undo, redo};
}

// ---------------------------------------------------------------------------------------------
// Files: the moodboard folder is picked once (File System Access API, Chrome and Edge); each save
// writes <name>.png and <name>.json there and adds the image to moodboard.md. Without the API the
// two files are downloaded instead.
// ---------------------------------------------------------------------------------------------

type WithLab = Window & {__lab?: {update: (partial: Partial<Params>) => void}};

type WithDirectoryPicker = Window & {
	showDirectoryPicker?: (options: {mode: 'readwrite'}) => Promise<FileSystemDirectoryHandle>;
};

async function writeFile(folder: FileSystemDirectoryHandle, name: string, data: Blob | string) {
	const handle = await folder.getFileHandle(name, {create: true});
	const stream = await handle.createWritable();
	await stream.write(data);
	await stream.close();
}

async function readText(folder: FileSystemDirectoryHandle, name: string): Promise<string> {
	const handle = await folder.getFileHandle(name, {create: true});
	const file = await handle.getFile();
	return file.text();
}

function download(name: string, data: Blob | string) {
	const blob = typeof data === 'string' ? new Blob([data], {type: 'application/json'}) : data;
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

// The WebGL canvas is transparent; the background is CSS. Put it under the image unless the
// transparent option is on.
function renderPng(gl: THREE.WebGLRenderer, p: Params): Promise<Blob | null> {
	const source = gl.domElement;
	const canvas = document.createElement('canvas');
	canvas.width = source.width;
	canvas.height = source.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return Promise.resolve(null);
	}
	if (!p.transparent) {
		ctx.fillStyle = p.background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}
	ctx.drawImage(source, 0, 0);
	return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function fileStamp(): string {
	return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function summary(p: Params): string {
	const parts = [p.shape, p.render, p.color];
	if (p.flat) {
		parts.push('facets');
	}
	if (p.unlit) {
		parts.push('unlit');
	}
	if (p.transmission > 0) {
		parts.push('glass');
	}
	if (p.iridescence > 0) {
		parts.push('iridescent');
	}
	if (!p.sameInner) {
		parts.push(`inside ${p.innerColor}`);
	}
	return parts.join(', ');
}

function isParams(value: unknown): value is Params {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return Object.keys(DEFAULTS).every((key) => key in value);
}

// A params file saved before a key existed gets the default for it.
function withDefaults(value: unknown): Params | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const merged: unknown = {...DEFAULTS, ...value};
	if (!isParams(merged)) {
		return null;
	}
	return merged;
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export function LogoLab() {
	// ?preset=Name opens a preset, so a look can be shared by link; any other parameter in the URL
	// overrides one value, as JSON (?background="%23000000"&transparent=true).
	const {p, update, undo, redo} = useHistory(() => {
		const query = new URLSearchParams(window.location.search);
		const name = query.get('preset');
		const preset = name ? PRESETS[name] : undefined;
		const overrides: Record<string, unknown> = {};
		for (const [key, value] of query) {
			if (key === 'preset' || !(key in DEFAULTS)) {
				continue;
			}
			overrides[key] = JSON.parse(value);
		}
		const merged: unknown = {...DEFAULTS, ...preset, ...overrides};
		if (!isParams(merged)) {
			return {...DEFAULTS, ...preset};
		}
		return merged;
	});
	const glRef = useRef<THREE.WebGLRenderer | null>(null);
	// For scripts driving the page (frame capture): window.__lab.update(partial params).
	useEffect(() => {
		(window as WithLab).__lab = {update: (partial) => update((prev) => ({...prev, ...partial}))};
	}, [update]);
	const folderRef = useRef<FileSystemDirectoryHandle | null>(null);
	const [folderName, setFolderName] = useState<string | null>(null);
	const [lastSaved, setLastSaved] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const set =
		<K extends keyof Params>(k: K) =>
		(v: Params[K]) =>
			update((prev) => ({...prev, [k]: v}));

	const snapshot = async () => {
		const gl = glRef.current;
		if (!gl) {
			return;
		}
		const png = await renderPng(gl, p);
		if (!png) {
			return;
		}
		download(`wormhole-${p.shape}.png`, png);
	};

	const copyParams = () => {
		void navigator.clipboard.writeText(JSON.stringify(p, null, 2));
	};

	const chooseFolder = async (): Promise<FileSystemDirectoryHandle | null> => {
		const picker = (window as WithDirectoryPicker).showDirectoryPicker;
		if (!picker) {
			return null;
		}
		const handle = await picker.call(window, {mode: 'readwrite'}).catch(() => null);
		if (!handle) {
			return null;
		}
		folderRef.current = handle;
		setFolderName(handle.name);
		return handle;
	};

	const saveForLater = async () => {
		const gl = glRef.current;
		if (!gl) {
			return;
		}
		const name = `${fileStamp()}-${p.shape}`;
		const png = await renderPng(gl, p);
		if (!png) {
			return;
		}
		const json = JSON.stringify(p, null, 2);

		const folder = folderRef.current ?? (await chooseFolder());
		if (!folder) {
			download(`${name}.png`, png);
			download(`${name}.json`, json);
			setLastSaved(`${name} (downloaded)`);
			return;
		}

		await writeFile(folder, `${name}.png`, png);
		await writeFile(folder, `${name}.json`, json);
		const existing = await readText(folder, 'moodboard.md');
		const head = existing.trim() === '' ? '# Logo moodboard\n' : existing;
		const entry = `\n## ${name}\n\n![${name}](${name}.png)\n\n${summary(p)} ([params](${name}.json))\n`;
		await writeFile(folder, 'moodboard.md', head + entry);
		setLastSaved(name);
	};

	const openParams = async (file: File | undefined) => {
		if (!file) {
			return;
		}
		const parsed = withDefaults(JSON.parse(await file.text()));
		if (!parsed) {
			return;
		}
		update(parsed);
	};

	return (
		<div className="flex h-dvh w-full bg-background text-foreground">
			<div
				className="relative flex-1"
				style={{background: p.transparent ? 'transparent' : p.background}}
			>
				<Canvas
					gl={{preserveDrawingBuffer: true, alpha: true, antialias: true}}
					dpr={[1, 2]}
					onCreated={({gl}) => {
						glRef.current = gl;
					}}
				>
					<Scene p={p} />
				</Canvas>
				<div className="pointer-events-none absolute top-4 left-4 text-xs text-muted-foreground">
					Drag to orbit, scroll to zoom. Cmd+Z undoes, Cmd+Shift+Z redoes. Temporary page, never
					shipped.
				</div>
			</div>

			<aside className="w-88 shrink-0 overflow-y-auto border-l border-border px-4 py-3">
				<div className="flex items-center justify-between pb-3">
					<h1 className="text-sm font-medium">Logo lab</h1>
					<div className="flex gap-1.5">
						<button
							onClick={undo}
							className="h-8 rounded-md border border-border px-2 text-sm hover:bg-muted"
							title="Cmd+Z"
						>
							Undo
						</button>
						<button
							onClick={redo}
							className="h-8 rounded-md border border-border px-2 text-sm hover:bg-muted"
							title="Cmd+Shift+Z"
						>
							Redo
						</button>
					</div>
				</div>

				<Section title="Moodboard">
					<div className="flex flex-wrap gap-1.5">
						<button
							onClick={() => void saveForLater()}
							className="h-8 rounded-md bg-foreground px-3 text-sm text-background hover:opacity-90"
						>
							Save for later
						</button>
						<button
							onClick={() => void chooseFolder()}
							className="h-8 rounded-md border border-border px-3 text-sm hover:bg-muted"
						>
							{folderName ? `Folder: ${folderName}` : 'Choose folder'}
						</button>
						<button
							onClick={() => fileInput.current?.click()}
							className="h-8 rounded-md border border-border px-3 text-sm hover:bg-muted"
						>
							Open params
						</button>
						<input
							ref={fileInput}
							type="file"
							accept="application/json"
							className="hidden"
							onChange={(e) => {
								void openParams(e.target.files?.[0]);
								e.target.value = '';
							}}
						/>
						<button
							onClick={() => void snapshot()}
							className="h-8 rounded-md border border-border px-3 text-sm hover:bg-muted"
						>
							PNG
						</button>
						<button
							onClick={copyParams}
							className="h-8 rounded-md border border-border px-3 text-sm hover:bg-muted"
						>
							Copy params
						</button>
					</div>
					<p className="text-xs text-muted-foreground">
						{lastSaved
							? `Saved ${lastSaved}`
							: 'Save writes a PNG and the params as JSON into the folder you pick, and lists the image in moodboard.md there.'}
					</p>
				</Section>
				<Section title="Presets">
					<div className="flex flex-wrap gap-1.5">
						{Object.entries(PRESETS).map(([name, preset]) => (
							<button
								key={name}
								onClick={() => update({...DEFAULTS, ...preset})}
								className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
							>
								{name}
							</button>
						))}
					</div>
				</Section>

				<Section title="Shape">
					<Choice
						label="Profile"
						value={p.shape}
						options={['hyperboloid', 'catenoid', 'power', 'trumpet'] as const}
						onChange={set('shape')}
					/>
					<Range label="Throat" value={p.throat} min={0.02} max={1.5} onChange={set('throat')} />
					<Range label="Mouth" value={p.mouth} min={0.1} max={3} onChange={set('mouth')} />
					<Range label="Length" value={p.length} min={0.2} max={6} onChange={set('length')} />
					{(p.shape === 'power' || p.shape === 'trumpet') && (
						<Range label="Curve" value={p.power} min={0.3} max={6} onChange={set('power')} />
					)}
					<Range label="Rolled lip" value={p.lip} min={0} max={0.5} onChange={set('lip')} />
					<Range label="Rings" value={p.rings} min={2} max={200} step={1} onChange={set('rings')} />
					<Range
						label="Segments"
						value={p.segments}
						min={3}
						max={200}
						step={1}
						onChange={set('segments')}
					/>
					<Check label="Flat shading (facets)" value={p.flat} onChange={set('flat')} />
				</Section>

				<Section title="Surface">
					<Choice
						label="Render"
						value={p.render}
						options={['solid', 'wireframe', 'grid'] as const}
						onChange={set('render')}
					/>
					{p.render === 'grid' && (
						<>
							<Range
								label="Ring every"
								value={p.gridRingEvery}
								min={1}
								max={20}
								step={1}
								onChange={set('gridRingEvery')}
							/>
							<Range
								label="Meridians"
								value={p.gridMeridians}
								min={0}
								max={96}
								step={1}
								onChange={set('gridMeridians')}
							/>
						</>
					)}
					<Check label="Unlit (flat colour, no light)" value={p.unlit} onChange={set('unlit')} />
					<Color label="Colour" value={p.color} onChange={set('color')} />
					<Check label="Inside same as outside" value={p.sameInner} onChange={set('sameInner')} />
					{!p.sameInner && (
						<Color label="Inside" value={p.innerColor} onChange={set('innerColor')} />
					)}
					<Range
						label="Metalness"
						value={p.metalness}
						min={0}
						max={1}
						onChange={set('metalness')}
					/>
					<Range
						label="Roughness"
						value={p.roughness}
						min={0}
						max={1}
						onChange={set('roughness')}
					/>
					<Range
						label="Clearcoat"
						value={p.clearcoat}
						min={0}
						max={1}
						onChange={set('clearcoat')}
					/>
					<Range
						label="Iridescence"
						value={p.iridescence}
						min={0}
						max={1}
						onChange={set('iridescence')}
					/>
					<Range
						label="Glass"
						value={p.transmission}
						min={0}
						max={1}
						onChange={set('transmission')}
					/>
					<Range label="Opacity" value={p.opacity} min={0} max={1} onChange={set('opacity')} />
				</Section>

				<Section title="Rotation">
					<Range label="X" value={p.rotX} min={-180} max={180} step={1} onChange={set('rotX')} />
					<Range label="Y" value={p.rotY} min={-180} max={180} step={1} onChange={set('rotY')} />
					<Range label="Z" value={p.rotZ} min={-180} max={180} step={1} onChange={set('rotZ')} />
					<Range label="Turn" value={p.turn} min={0} max={360} step={1} onChange={set('turn')} />
					<Choice
						label="Spin around"
						value={p.spinAxis}
						options={['none', 'x', 'y', 'z'] as const}
						onChange={set('spinAxis')}
					/>
					<Range
						label="Spin speed"
						value={p.spinSpeed}
						min={0}
						max={4}
						onChange={set('spinSpeed')}
					/>
				</Section>

				<Section title="Lighting">
					<LightControls name="Key" light={p.key} onChange={set('key')} />
					<LightControls name="Fill" light={p.fill} onChange={set('fill')} />
					<LightControls name="Rim" light={p.rim} onChange={set('rim')} />
					<Range label="Ambient" value={p.ambient} min={0} max={3} onChange={set('ambient')} />
					<Check label="Studio reflections (softboxes)" value={p.studio} onChange={set('studio')} />
					{p.studio && (
						<Range
							label="Reflections"
							value={p.studioIntensity}
							min={0}
							max={4}
							onChange={set('studioIntensity')}
						/>
					)}
				</Section>

				<Section title="Scene">
					<Color label="Background" value={p.background} onChange={set('background')} />
					<Check
						label="Transparent (for PNG)"
						value={p.transparent}
						onChange={set('transparent')}
					/>
					<Range
						label="Camera FOV"
						value={p.fov}
						min={10}
						max={90}
						step={1}
						onChange={set('fov')}
					/>
				</Section>
			</aside>
		</div>
	);
}

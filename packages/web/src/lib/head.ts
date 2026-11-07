import {Result} from 'ts-results-es';
import {type AvatarColor, isAvatarColor, type Look} from '@proxy/utils/harness';
import type {Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer} from 'three';

/**
 * A persona's head: a ball in the persona's color covered in straight strands with round tips,
 * unlit, under a perspective camera, with two upright ink pills painted flat on top where its eyes are, so they follow the
 * turning ball without ever turning themselves. The strands are laid out from a seed taken from the
 * persona's look, so every persona has fur of its own. One three.js renderer serves every head on
 * the page, loaded the first time a head is drawn, as its own chunk: a head is rendered into the
 * renderer's canvas and copied into its own. A still head is rendered once per look, color, pose
 * and size, and copied from then on; a live one is rendered every frame.
 */

type Three = typeof import('three');

/** How a head is turned: a nod about x, a turn about y and a tilt about z, in degrees, as the lab has them. */
export type Pose = {rotX: number; rotY: number; rotZ: number};

/** The pose of the lab's first look: turned three-quarters toward you. Every still head takes it. */
export const REST: Pose = {rotX: -3, rotY: -65, rotZ: -12};

/** Looking straight at you. */
export const FACING: Pose = {rotX: 0, rotY: -90, rotZ: 0};

/** Cursor-follow timing, in milliseconds: ordinary tracking and the gentler first response. */
export const FOLLOW_TIME_MS = 100;
export const FIRST_HOVER_FOLLOW_TIME_MS = 180;
export const FIRST_HOVER_DURATION_MS = 600;

/** A refresh-rate-independent share of the distance to travel during one animation frame. */
export function followAmount(elapsedMs: number, timeConstantMs: number): number {
	return 1 - Math.exp(-elapsedMs / timeConstantMs);
}

/** The timing for this frame: gentler only during the first response to a hover. */
export function followTime(watching: boolean, now: number, firstHoverUntil: number): number {
	if (watching && now < firstHoverUntil) {
		return FIRST_HOVER_FOLLOW_TIME_MS;
	}
	return FOLLOW_TIME_MS;
}

// How far the head turns toward the cursor, in degrees, at the edge of its canvas. Measuring
// against the head itself keeps the movement visible while the pointer is inside its hover area.
const TURN = 45;
const NOD = 30;
const TILT = 10;

function clamp(value: number): number {
	return Math.max(-1, Math.min(1, value));
}

/** The pose looking from the center of a head's bounds toward a pointer within or beyond them. */
export function poseTowardPointer(
	pointer: {x: number; y: number},
	bounds: {left: number; top: number; width: number; height: number},
	range: {width: number; height: number} = bounds,
): Pose {
	const dx = clamp((pointer.x - (bounds.left + bounds.width / 2)) / (range.width / 2));
	const dy = clamp((pointer.y - (bounds.top + bounds.height / 2)) / (range.height / 2));
	return {rotX: dy * NOD, rotY: FACING.rotY + dx * TURN, rotZ: -dx * TILT};
}

const DEG = Math.PI / 180;
// The palette, as OKLCH, the same hues as the stylesheet's avatar colors.
const HUES: Record<Exclude<AvatarColor, 'mono'>, [number, number, number]> = {
	red: [0.64, 0.21, 25],
	orange: [0.72, 0.17, 55],
	yellow: [0.8, 0.16, 90],
	green: [0.68, 0.17, 150],
	teal: [0.7, 0.13, 195],
	blue: [0.62, 0.19, 255],
	purple: [0.62, 0.2, 300],
	pink: [0.7, 0.19, 350],
};
// The fur and the eyes: how many strands, how far they reach past the ball and how thick they are,
// both as shares of its radius, and how much they vary; the eyes' size, how far apart they sit in
// degrees, and their ink.
const FUR = {count: 60, length: 0.36, width: 0.18, messiness: 0.45};
const EYES = {size: 0.385, spread: 21, ink: '#18181b'};
// How far the ink pills slide toward where the head looks, as a share of their size.
const PILL_SLIDE = 0.3;
// Strands start inside the ball, this far from its center, and reach this much further than their
// length past its surface, so their roots never show.
const STRAND_START = 0.82;
const STRAND_INSET = 0.18;
// How far from the middle of the camera's view the farthest strand may reach, in degrees: a little
// short of the edge, half of its 30°, so a head is never clipped.
const FRAME = 14;

/** How long a blink takes, in milliseconds: the eyes closing and opening again. */
export const BLINK_MS = 160;
// How far the eyes close at the middle of a blink, as a share of their height.
const BLINK_CLOSE = 0.88;
// How long a head following the cursor goes between blinks of its own, in milliseconds.
const BLINK_EVERY_MS = {least: 2000, most: 6000};

/** How closed the eyes are, 0 to 1, at `now` in a blink that started at `start`; open with none. */
export function blinkAmount(now: number, start: number | null): number {
	if (start === null || now < start || now - start >= BLINK_MS) {
		return 0;
	}
	return 1 - Math.abs((2 * (now - start)) / BLINK_MS - 1);
}

/** How long until a head following the cursor blinks again, in milliseconds. */
export function nextBlinkDelay(random: () => number = Math.random): number {
	return BLINK_EVERY_MS.least + random() * (BLINK_EVERY_MS.most - BLINK_EVERY_MS.least);
}

// How many times the heads have had to draw themselves again since the page opened, as its theme
// changed, which mono heads take their color from.
let redraws = 0;
const redrawListeners = new Set<() => void>();
let themeWatch: MutationObserver | null = null;

function redrawAll(): void {
	redraws++;
	for (const listener of redrawListeners) {
		listener();
	}
}

/** Calls `listener` whenever the heads should be drawn again; returns what stops it. */
export function subscribeRedraw(listener: () => void): () => void {
	redrawListeners.add(listener);
	if (themeWatch === null && typeof MutationObserver !== 'undefined') {
		themeWatch = new MutationObserver(redrawAll);
		themeWatch.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
	}
	return () => {
		redrawListeners.delete(listener);
	};
}

/** How many times the heads have had to be drawn again, as a version for `useSyncExternalStore`. */
export function redrawVersion(): number {
	return redraws;
}

// How many rendered heads are kept, and how many models.
const CACHE_MAX = 300;
const MODELS_MAX = 100;

function oklchToHex(L: number, C: number, h: number): string {
	const a = C * Math.cos(h * DEG);
	const b = C * Math.sin(h * DEG);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	const gamma = (x: number) => {
		const clamped = Math.max(0, Math.min(1, x));
		return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
	};
	return `#${[r, g, bb]
		.map((x) =>
			Math.round(gamma(x) * 255)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;
}

// Mono, the page's ink, on a light page and on a dark one.
const MONO = {light: '#18181b', dark: '#fafafa'};

// Whether the page is in its dark theme, as the theme provider marks it on the root element.
function pageIsDark(): boolean {
	return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function hexOf(color: string): string {
	if (color === 'mono') {
		return pageIsDark() ? MONO.dark : MONO.light;
	}
	return oklchToHex(...HUES[isAvatarColor(color) && color !== 'mono' ? color : 'blue']);
}

// The eyes' ink: near-black, but white on mono's near-black body, so they still show.
function inkOf(color: string): string {
	if (color === 'mono' && !pageIsDark()) {
		return '#ffffff';
	}
	return EYES.ink;
}

// A number from the look, so the same persona always gets the same fur.
function seedOf(look: Look): number {
	const text = JSON.stringify(look);
	let h = 1779033703 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return h >>> 0;
}

// A random number generator from a seed (mulberry32).
function random(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** What makes one head: its look and its color. */
export type HeadSpec = {look: Look; color: string};

// One head's model: the ball and its fur, how far the fur reaches, and where on the ball its eyes are.
type Model = {group: Group; reach: number; eyes: Vector3[]};

type Stage = {
	three: Three;
	renderer: WebGLRenderer;
	scene: Scene;
	camera: PerspectiveCamera;
	sphere: import('three').SphereGeometry;
	strand: import('three').CylinderGeometry;
	models: Map<string, Model>;
	rendered: Map<string, HTMLCanvasElement>;
};

let loading: Promise<Stage | null> | null = null;

// Builds the stage once: the renderer, the shapes every head is made of and the camera. Null where
// there is no WebGL, as in tests, so a head is left blank rather than thrown on.
async function build(): Promise<Stage | null> {
	if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') {
		return null;
	}
	const three = await import('three');
	// The renderer throws where WebGL is there but can't be had, as with a context lost.
	const renderer = Result.wrap(
		() =>
			new three.WebGLRenderer({
				antialias: true,
				alpha: true,
				preserveDrawingBuffer: true,
			}),
	);
	if (renderer.isErr()) {
		return null;
	}
	renderer.value.setClearColor(0, 0);
	return {
		three,
		renderer: renderer.value,
		scene: new three.Scene(),
		camera: new three.PerspectiveCamera(30, 1, 0.1, 100),
		sphere: new three.SphereGeometry(1, 32, 24),
		strand: new three.CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0),
		models: new Map(),
		rendered: new Map(),
	};
}

/** The stage every head is drawn on, loaded the first time; null where heads can't be drawn. */
export function loadStage(): Promise<Stage | null> {
	if (loading === null) {
		loading = build();
	}
	return loading;
}

// The head's model, facing +z: a ball, and strands spread evenly over it from the persona's seed,
// each leaning a little and ending in a ball as wide as itself, kept clear of where the eyes are.
function model(stage: Stage, spec: HeadSpec): Model {
	const key = JSON.stringify([spec.look, hexOf(spec.color)]);
	const cached = stage.models.get(key);
	if (cached) {
		return cached;
	}
	const {three} = stage;
	const next = random(seedOf(spec.look));
	const material = new three.MeshBasicMaterial({color: hexOf(spec.color)});
	const group = new three.Group();
	group.add(new three.Mesh(stage.sphere, material));
	const eyes = [-1, 1].map(
		(side) => new three.Vector3(Math.sin(side * EYES.spread * DEG), 0, Math.cos(EYES.spread * DEG)),
	);
	const {count, width} = FUR;
	const strands = new three.InstancedMesh(stage.strand, material, count);
	const tips = new three.InstancedMesh(stage.sphere, material, count);
	const clear = Math.cos(EYES.size * 1.15);
	const golden = Math.PI * (3 - Math.sqrt(5));
	const up = new three.Vector3(0, 1, 0);
	const matrix = new three.Matrix4();
	const turn = new three.Quaternion();
	const none = new three.Quaternion();
	const base = new three.Vector3();
	const tip = new three.Vector3();
	let placed = 0;
	for (let i = 0; i < count; i++) {
		const y = 1 - (i / (count - 1)) * 2;
		const ring = Math.sqrt(1 - y * y);
		const direction = new three.Vector3(
			Math.cos(golden * i) * ring,
			y,
			Math.sin(golden * i) * ring,
		);
		direction.x += (next() - 0.5) * 0.12 * FUR.messiness;
		direction.y += (next() - 0.5) * 0.12 * FUR.messiness;
		direction.z += (next() - 0.5) * 0.12 * FUR.messiness;
		direction.normalize();
		const length = FUR.length * (1 - FUR.messiness * 0.5 + next() * FUR.messiness) + STRAND_INSET;
		const lean = direction
			.clone()
			.add(
				new three.Vector3(next() - 0.5, next() - 0.5, next() - 0.5).multiplyScalar(
					0.35 * FUR.messiness,
				),
			)
			.normalize();
		if (eyes.some((eye) => eye.dot(direction) > clear)) {
			continue;
		}
		base.copy(direction).multiplyScalar(STRAND_START);
		turn.setFromUnitVectors(up, lean);
		matrix.compose(base, turn, new three.Vector3(width, length, width));
		strands.setMatrixAt(placed, matrix);
		tip.copy(lean).multiplyScalar(length).add(base);
		matrix.compose(tip, none, new three.Vector3(width, width, width));
		tips.setMatrixAt(placed, matrix);
		placed++;
	}
	strands.count = placed;
	tips.count = placed;
	group.add(strands, tips);
	// The farthest any strand can reach from the center: where strands start, the longest one,
	// and the ball on its tip.
	const reach = STRAND_START + FUR.length * (1 + FUR.messiness * 0.5) + STRAND_INSET + width;
	const made = {group, reach, eyes};
	if (stage.models.size >= MODELS_MAX) {
		forget(stage);
	}
	stage.models.set(key, made);
	return made;
}

// Lets go of every model kept, and what each holds on the graphics card; the shapes they share stay.
function forget(stage: Stage): void {
	for (const kept of stage.models.values()) {
		kept.group.traverse((part) => {
			if (part instanceof stage.three.InstancedMesh) {
				part.dispose();
			}
			if (part instanceof stage.three.Mesh && part.material instanceof stage.three.Material) {
				part.material.dispose();
			}
		});
	}
	stage.models.clear();
}

// Paints the eyes flat on the rendered head: for each eye, where its spot on the ball lands on the
// canvas, an upright ink pill, slid a little toward where the head looks. The pills are kept level
// and alike, at the height and size the two would have on average, so a tilted or turned head
// never shows one eye higher or larger than the other. An eye turned to the far side of the ball
// isn't painted.
function paintEyes(
	stage: Stage,
	context: CanvasRenderingContext2D,
	made: Model,
	spec: HeadSpec,
	pose: Pose,
	px: number,
	blink: number,
): void {
	const {camera} = stage;
	const lookX = Math.sin((pose.rotY - FACING.rotY) * DEG);
	const lookY = Math.sin(pose.rotX * DEG);
	const at = new stage.three.Vector3();
	const inCamera = new stage.three.Vector3();
	const spots: {x: number; y: number; radius: number}[] = [];
	for (const eye of made.eyes) {
		at.copy(eye).applyMatrix4(made.group.matrixWorld);
		if (at.dot(camera.position.clone().sub(at)) <= 0) {
			continue;
		}
		inCamera.copy(at).applyMatrix4(camera.matrixWorldInverse);
		const radius = (EYES.size * px) / (2 * -inCamera.z * Math.tan((camera.fov / 2) * DEG));
		at.project(camera);
		spots.push({x: ((at.x + 1) / 2) * px, y: ((1 - at.y) / 2) * px, radius});
	}
	if (spots.length === 0) {
		return;
	}
	const radius = spots.reduce((sum, spot) => sum + spot.radius, 0) / spots.length;
	const y =
		spots.reduce((sum, spot) => sum + spot.y, 0) / spots.length + lookY * radius * PILL_SLIDE;
	const width = radius * 0.72;
	// Blinking, the pills close toward their middle, rounded at whichever side is shorter.
	const height = Math.max(radius * 1.85 * (1 - blink * BLINK_CLOSE), 1);
	context.fillStyle = inkOf(spec.color);
	for (const spot of spots) {
		const x = spot.x + lookX * radius * PILL_SLIDE;
		context.beginPath();
		context.roundRect(x - width / 2, y - height / 2, width, height, Math.min(width, height) / 2);
		context.fill();
	}
}

// Renders the head, eyes and all, onto `target`, `px` wide and high.
function render(
	stage: Stage,
	target: HTMLCanvasElement,
	spec: HeadSpec,
	pose: Pose,
	px: number,
	blink: number,
): void {
	const made = model(stage, spec);
	stage.renderer.setSize(px, px, false);
	stage.camera.position.set(0, 0, made.reach / Math.sin(FRAME * DEG));
	stage.camera.lookAt(0, 0, 0);
	stage.camera.updateMatrixWorld();
	made.group.rotation.set(pose.rotX * DEG, (pose.rotY - FACING.rotY) * DEG, pose.rotZ * DEG);
	stage.scene.add(made.group);
	stage.renderer.render(stage.scene, stage.camera);
	stage.scene.remove(made.group);
	made.group.updateMatrixWorld();
	if (target.width !== px || target.height !== px) {
		target.width = px;
		target.height = px;
	}
	const context = target.getContext('2d');
	if (!context) {
		return;
	}
	context.clearRect(0, 0, px, px);
	context.drawImage(stage.renderer.domElement, 0, 0);
	paintEyes(stage, context, made, spec, pose, px, blink);
}

// The head rendered once, kept as a canvas of its own for every other time it is drawn.
function still(stage: Stage, spec: HeadSpec, pose: Pose, px: number): HTMLCanvasElement {
	const key = JSON.stringify([spec, hexOf(spec.color), pose, px]);
	const cached = stage.rendered.get(key);
	if (cached) {
		return cached;
	}
	const copy = document.createElement('canvas');
	render(stage, copy, spec, pose, px, 0);
	if (stage.rendered.size >= CACHE_MAX) {
		stage.rendered.clear();
	}
	stage.rendered.set(key, copy);
	return copy;
}

/**
 * Draws the head on `target`, `px` wide and high: a still one from the cache, a live one rendered
 * now, its eyes `blink` closed (0 to 1).
 */
export function paintHead(
	stage: Stage,
	target: HTMLCanvasElement,
	spec: HeadSpec,
	pose: Pose,
	px: number,
	live: boolean,
	blink = 0,
): void {
	if (live) {
		render(stage, target, spec, pose, px, blink);
		return;
	}
	const source = still(stage, spec, pose, px);
	if (target.width !== px || target.height !== px) {
		target.width = px;
		target.height = px;
	}
	const context = target.getContext('2d');
	context?.clearRect(0, 0, px, px);
	context?.drawImage(source, 0, 0);
}

/** How many pixels a head `size` CSS pixels wide is drawn at, for the screen it is on. */
export function pixels(size: number): number {
	const ratio = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
	return Math.round(size * ratio);
}

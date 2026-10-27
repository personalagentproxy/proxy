import {Result} from 'ts-results-es';
import {type AvatarColor, isAvatarColor, type Look} from '@proxy/utils/harness';

/**
 * A persona's head, drawn as the head lab draws it (design/head-lab): a sphere in the persona's
 * color with the eyes painted on, and a darker sphere for the nose, unlit, under a perspective
 * camera. One three.js renderer serves every head on the page, loaded the first time a head is
 * drawn, as its own chunk: a head is rendered into the renderer's canvas and copied into its own.
 * A still head is rendered once per look, color, pose and size, and copied from then on; a live
 * one is rendered every frame.
 */

type Three = typeof import('three');

/** How a head is turned: a nod about x, a turn about y and a tilt about z, in degrees, as the lab has them. */
export type Pose = {rotX: number; rotY: number; rotZ: number};

/** The pose of the lab's first look: turned three-quarters toward you. Every still head takes it. */
export const REST: Pose = {rotX: -3, rotY: -65, rotZ: -12};

/** Looking straight at you. */
export const FACING: Pose = {rotX: 0, rotY: -90, rotZ: 0};

const DEG = Math.PI / 180;
// How much darker than the head the nose is, in OKLCH lightness, and how the head fills its box.
const NOSE_DARK = 0.22;
const ZOOM = 1.25;
// The lab's palette, as OKLCH, the same hues as the stylesheet's avatar colors.
const HUES: Record<AvatarColor, [number, number, number]> = {
	red: [0.64, 0.21, 25],
	orange: [0.72, 0.17, 55],
	yellow: [0.8, 0.16, 90],
	green: [0.68, 0.17, 150],
	teal: [0.7, 0.13, 195],
	blue: [0.62, 0.19, 255],
	purple: [0.62, 0.2, 300],
	pink: [0.7, 0.19, 350],
};
// How many rendered heads are kept.
const CACHE_MAX = 300;

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

function hues(color: string): [number, number, number] {
	return HUES[isAvatarColor(color) ? color : 'blue'];
}

function hexOf(color: string): string {
	return oklchToHex(...hues(color));
}

function noseOf(color: string): string {
	const [L, C, h] = hues(color);
	return oklchToHex(L - NOSE_DARK, C * 0.9, h);
}

/** What makes one head: its look and its color. */
export type HeadSpec = {look: Look; color: string};

type Stage = {
	three: Three;
	renderer: import('three').WebGLRenderer;
	scene: import('three').Scene;
	camera: import('three').PerspectiveCamera;
	head: import('three').Mesh<import('three').SphereGeometry, import('three').MeshBasicMaterial>;
	nose: import('three').Mesh<import('three').SphereGeometry, import('three').MeshBasicMaterial>;
	group: import('three').Group;
	outer: import('three').Group;
	textures: Map<string, import('three').CanvasTexture>;
	rendered: Map<string, HTMLCanvasElement>;
};

let loading: Promise<Stage | null> | null = null;

// Builds the stage once: the renderer, the two spheres and the camera, as the lab has them. Null
// where there is no WebGL, as in tests, so a head is left blank rather than thrown on.
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
	const sphere = new three.SphereGeometry(1, 96, 64);
	const camera = new three.PerspectiveCamera(35, 1, 0.1, 100);
	camera.position.z = 7;
	const scene = new three.Scene();
	const head = new three.Mesh(sphere, new three.MeshBasicMaterial());
	const nose = new three.Mesh(sphere, new three.MeshBasicMaterial());
	const group = new three.Group();
	group.add(head);
	group.add(nose);
	const outer = new three.Group();
	outer.add(group);
	scene.add(outer);
	return {
		three,
		renderer: renderer.value,
		scene,
		camera,
		head,
		nose,
		group,
		outer,
		textures: new Map(),
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

// The head's skin: its color, with the eyes painted where the look puts them, as the lab paints it.
function skin(stage: Stage, spec: HeadSpec): import('three').CanvasTexture {
	const key = JSON.stringify([
		spec.color,
		spec.look.eye,
		spec.look.eyeTheta,
		spec.look.eyeLat,
		spec.look.eyes,
	]);
	const cached = stage.textures.get(key);
	if (cached) {
		return cached;
	}
	const width = 2048;
	const height = 1024;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('No 2d context for a head');
	}
	context.fillStyle = hexOf(spec.color);
	context.fillRect(0, 0, width, height);
	const v = 0.5 + (spec.look.eyeLat * DEG) / Math.PI;
	const radius = (height / Math.PI) * spec.look.eye * DEG;
	const sides = spec.look.eyes === 1 ? [-1] : [-1, 1];
	for (const side of sides) {
		const phi = Math.PI + side * spec.look.eyeTheta * DEG;
		const u = phi / (2 * Math.PI);
		context.fillStyle = '#ffffff';
		context.beginPath();
		context.ellipse(
			u * width,
			(1 - v) * height,
			radius / Math.cos(spec.look.eyeLat * DEG),
			radius,
			0,
			0,
			Math.PI * 2,
		);
		context.fill();
	}
	const texture = new stage.three.CanvasTexture(canvas);
	texture.colorSpace = stage.three.SRGBColorSpace;
	texture.anisotropy = 8;
	if (stage.textures.size > 50) {
		for (const old of stage.textures.values()) {
			old.dispose();
		}
		stage.textures.clear();
	}
	stage.textures.set(key, texture);
	return texture;
}

// Renders the head into the renderer's canvas, `px` wide and high.
function render(stage: Stage, spec: HeadSpec, pose: Pose, px: number): HTMLCanvasElement {
	stage.renderer.setSize(px, px, false);
	stage.head.material.map = skin(stage, spec);
	stage.head.material.needsUpdate = true;
	stage.nose.material.color.set(noseOf(spec.color));
	stage.nose.scale.setScalar(spec.look.nose);
	stage.nose.position.set(1 + spec.look.noseOut * spec.look.nose, 0, 0);
	stage.group.rotation.set(pose.rotX * DEG, pose.rotY * DEG, pose.rotZ * DEG);
	stage.outer.scale.setScalar(ZOOM);
	stage.renderer.render(stage.scene, stage.camera);
	return stage.renderer.domElement;
}

// The head rendered once, kept as a canvas of its own for every other time it is drawn.
function still(stage: Stage, spec: HeadSpec, pose: Pose, px: number): HTMLCanvasElement {
	const key = JSON.stringify([spec, pose, px]);
	const cached = stage.rendered.get(key);
	if (cached) {
		return cached;
	}
	const source = render(stage, spec, pose, px);
	const copy = document.createElement('canvas');
	copy.width = px;
	copy.height = px;
	copy.getContext('2d')?.drawImage(source, 0, 0);
	if (stage.rendered.size >= CACHE_MAX) {
		stage.rendered.clear();
	}
	stage.rendered.set(key, copy);
	return copy;
}

/**
 * Draws the head on `target`, `px` wide and high: a still one from the cache, a live one rendered
 * now.
 */
export function paintHead(
	stage: Stage,
	target: HTMLCanvasElement,
	spec: HeadSpec,
	pose: Pose,
	px: number,
	live: boolean,
): void {
	const source = live ? render(stage, spec, pose, px) : still(stage, spec, pose, px);
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

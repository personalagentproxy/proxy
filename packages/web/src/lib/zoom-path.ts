// The way from one view of a timeline to another: the stretch of time shown, as its middle and
// its width. Zooming in on a part of it, or out to another, pans and zooms at once, and done as
// two motions laid over each other, each at its own pace, the view seems to slide off and come
// back. This is the path of van Wijk and Nuij ("Smooth and efficient zooming and panning", 2003),
// which maps fly along from one place to another: pan and zoom as one curve, zooming out a little
// on the way where the two views are far apart, so the view seems to move at one even pace the
// whole way.

export type View = {center: number; width: number};

// How much the path zooms out to cover ground: the square root of two is what feels right to
// most, as the paper found.
const RHO = Math.SQRT2;

// Below this, as a share of the widths, the two middles are taken as one, and the path only zooms.
const STILL = 1e-6;

/** The view `t` of the way from `from` to `to`, `t` from 0 to 1. */
export function zoomPath(from: View, to: View): (t: number) => View {
	const w0 = from.width;
	const w1 = to.width;
	const dx = to.center - from.center;
	const d = Math.abs(dx);
	if (d < STILL * Math.max(w0, w1)) {
		const k = Math.log(w1 / w0);
		return (t) => ({center: from.center + dx * t, width: w0 * Math.exp(k * t)});
	}
	const rho2 = RHO * RHO;
	const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d * d) / (2 * w0 * rho2 * d);
	const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d * d) / (2 * w1 * rho2 * d);
	const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
	const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
	const span = (r1 - r0) / RHO;
	const coshR0 = Math.cosh(r0);
	const sinhR0 = Math.sinh(r0);
	return (t) => {
		const s = RHO * t * span + r0;
		const u = (w0 / (rho2 * d)) * (coshR0 * Math.tanh(s) - sinhR0);
		return {center: from.center + u * dx, width: (w0 * coshR0) / Math.cosh(s)};
	};
}

/**
 * 几何计算 / Geometry helpers
 *
 * 全部基于 mil 坐标。焊盘统一用轴对齐外接盒（RECT/多边形保守近似，
 * 椭圆用外接盒同样保守：宁可拒绝可用位置，不放过冲突位置）。
 */
import type { BoardOutline, BoardPad, Point } from './types.ts';

/** 两线段中心线最小距离（相交为 0） */
export function distSegSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
	const d1x = bx - ax;
	const d1y = by - ay;
	const d2x = dx - cx;
	const d2y = dy - cy;
	const denom = d1x * d2y - d1y * d2x;
	if (denom !== 0) {
		// 求交点参数，均在 [0,1] 内则相交
		const ex = cx - ax;
		const ey = cy - ay;
		const t = (ex * d2y - ey * d2x) / denom;
		const u = (ex * d1y - ey * d1x) / denom;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
			return 0;
	}
	return Math.min(
		distPointSeg(ax, ay, cx, cy, dx, dy),
		distPointSeg(bx, by, cx, cy, dx, dy),
		distPointSeg(cx, cy, ax, ay, bx, by),
		distPointSeg(dx, dy, ax, ay, bx, by),
	);
}

/** 点到线段最近距离 */
export function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0)
		return Math.hypot(px - ax, py - ay);
	let t = ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点到轴对齐矩形（中心 cx,cy，半宽 hw,半高 hh）的距离：内部为负的穿入深度 */
export function distPointRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number): number {
	const dx = Math.max(Math.abs(px - cx) - hw, 0);
	const dy = Math.max(Math.abs(py - cy) - hh, 0);
	if (dx === 0 && dy === 0) {
		// 点在矩形内部：返回到最近边的负距离
		const inside = Math.min(hw - Math.abs(px - cx), hh - Math.abs(py - cy));
		return -inside;
	}
	return Math.hypot(dx, dy);
}

/**
 * 焊盘沿某方向的延伸半径（中心 -> 外缘）。
 * 统一用轴对齐外接盒投影：与 pointPadClearance 的盒模型一致（保守但自洽），
 * 避免椭圆精确半径与盒角区域冲突导致“间隙为负”的矛盾。
 * useMask 为真时外扩阻焊层单边扩展（读不到为 0），即以阻焊开窗边缘作为焊盘边界。
 */
export function padExtent(pad: BoardPad, angleRad: number, useMask = false): number {
	const c = Math.abs(Math.cos(angleRad));
	const s = Math.abs(Math.sin(angleRad));
	const mask = useMask ? (pad.maskExpansionMil ?? 0) : 0;
	return (c + s) * mask + c * (pad.sizeX / 2) + s * (pad.sizeY / 2);
}

/** 点到焊盘外缘的间隙（负数表示穿入） */
export function pointPadClearance(px: number, py: number, pad: BoardPad): number {
	return distPointRect(px, py, pad.x, pad.y, pad.sizeX / 2, pad.sizeY / 2);
}

/** 点到多边形边的最小距离 */
export function distToPolygonEdge(px: number, py: number, poly: Point[]): number {
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		min = Math.min(min, distPointSeg(px, py, a.x, a.y, b.x, b.y));
	}
	return min;
}

/** 射线法点在多边形内判断（边界算内） */
export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x;
		const yi = poly[i].y;
		const xj = poly[j].x;
		const yj = poly[j].y;
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
}

/** 点是否在板内且距板边 >= margin */
export function insideBoard(px: number, py: number, outline: BoardOutline, margin: number): boolean {
	const { bbox, points } = outline;
	if (px < bbox.minX + margin || px > bbox.maxX - margin || py < bbox.minY + margin || py > bbox.maxY - margin)
		return false;
	if (points.length >= 3 && !pointInPolygon(px, py, points))
		return false;
	if (points.length >= 3 && distToPolygonEdge(px, py, points) < margin)
		return false;
	return true;
}

/** 线段（胶囊体：中心线 + 宽度 w）与圆的间隙（负数表示相交） */
export function capsuleCircleClearance(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	w: number,
	cx: number,
	cy: number,
	r: number,
): number {
	return distPointSeg(cx, cy, ax, ay, bx, by) - w / 2 - r;
}

/** 两圆间隙（负数表示相交） */
export function circleClearance(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): number {
	return Math.hypot(x2 - x1, y2 - y1) - r1 - r2;
}

/**
 * 胶囊体（走线）与焊盘（外接盒）的近似间隙。
 * 做法：沿焊盘盒采边框点 + 端点，取最小“点到胶囊中心线距离 - 半线宽”。
 */
export function capsulePadClearance(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	w: number,
	pad: BoardPad,
): number {
	const hw = pad.sizeX / 2;
	const hh = pad.sizeY / 2;
	// 8 个盒边采样点 + 4 角
	const samples: Array<[number, number]> = [
		[pad.x - hw, pad.y - hh],
		[pad.x, pad.y - hh],
		[pad.x + hw, pad.y - hh],
		[pad.x - hw, pad.y],
		[pad.x + hw, pad.y],
		[pad.x - hw, pad.y + hh],
		[pad.x, pad.y + hh],
		[pad.x + hw, pad.y + hh],
	];
	let min = Number.POSITIVE_INFINITY;
	for (const [sx, sy] of samples)
		min = Math.min(min, distPointSeg(sx, sy, ax, ay, bx, by) - w / 2);
	// 走线端点落在焊盘内部时（同网络源焊盘），间隙为负 → 上层负责豁免源焊盘
	return min;
}

/**
 * 合成测试板：电源/地就近打孔 场景板
 *
 * 覆盖场景：
 * - C1 0603 电容（3V3/GND）：GND 焊盘旁已有过孔（合并跳过）；
 *   3V3 焊盘 45° 方向被异网络走线阻挡（应换方向）
 * - U2 SOT-223（4 脚全电源/地）：正常打孔
 * - J1 2 脚连接器（+5V/GND 大圆焊盘）：正常打孔
 * - U1 LQFP48（48 脚）：默认阈值 32 下整体忽略
 * - B1 BGA-256：整体忽略（保护 BGA）
 * - C9 板角 0603（1V8/GND）：朝板外的方向被板边拒绝
 * - R9 底层 0603（GND/3V3）：连线应落在底层
 * - T1 顶层单焊盘（3V3）：同层走线挡连线 -> 换方向
 * - T2 底层单焊盘（GND）：顶层走线不挡底层连线 -> 45° 直通
 * - J2 真直插（多层+全孔+焊环全过）-> 跳过；C20/C21/H6/H7/J3 脏孔各形态 -> 按贴片打孔
 */
import type { BoardPad, BoardState, BoardTrack, BoardVia, PadShapeKind, Point } from '../src/types.ts';
import { MM_TO_MIL } from '../src/types.ts';

const mm = (v: number) => v * MM_TO_MIL;

/** 板框 60 x 40 mm */
const BOARD_W = mm(60);
const BOARD_H = mm(40);
function pad(
	designator: string,
	padNumber: string,
	net: string,
	xMm: number,
	yMm: number,
	wMm: number,
	hMm: number,
	shape: PadShapeKind = 'RECT',
	layer = 1,
	pinCount = 2,
): BoardPad {
	return {
		compId: `pid-${designator}`,
		designator,
		padNumber,
		net,
		netClass: 'signal',
		x: mm(xMm),
		y: mm(yMm),
		sizeX: mm(wMm),
		sizeY: mm(hMm),
		shape,
		layer,
		pinCount,
	};
}

/** BGA 球阵（n×n，间距 pitch，球径 d，VDD/GND 交替） */
function bgaPads(designator: string, cxMm: number, cyMm: number, n: number, pitchMm: number, dMm: number): BoardPad[] {
	const out: BoardPad[] = [];
	const half = ((n - 1) * pitchMm) / 2;
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			const net = (r + c) % 2 === 0 ? 'VDD' : 'GND';
			out.push(pad(designator, `${String.fromCharCode(65 + r)}${c + 1}`, net, cxMm - half + c * pitchMm, cyMm - half + r * pitchMm, dMm, dMm, 'ELLIPSE', 1, n * n));
		}
	}
	return out;
}

/** LQFP48 四边引脚（仅用于 pin 数超限场景，形状简化） */
function lqfp48Pads(designator: string, cxMm: number, cyMm: number): BoardPad[] {
	const out: BoardPad[] = [];
	const half = 3.5;
	const pitch = 0.5;
	let pin = 0;
	for (let i = 0; i < 12; i++) {
		pin++;
		out.push(pad(designator, String(pin), pin % 6 === 0 ? '3V3' : pin % 7 === 0 ? 'GND' : `P${pin}`, cxMm - half, cyMm - half + (i + 0.5) * pitch, 0.3, 1.2, 'RECT', 1, 48));
		pin++;
		out.push(pad(designator, String(pin), pin % 6 === 0 ? '3V3' : pin % 7 === 0 ? 'GND' : `P${pin}`, cxMm - half + (i + 0.5) * pitch, cyMm + half, 1.2, 0.3, 'RECT', 1, 48));
		pin++;
		out.push(pad(designator, String(pin), pin % 6 === 0 ? '3V3' : pin % 7 === 0 ? 'GND' : `P${pin}`, cxMm + half, cyMm + half - (i + 0.5) * pitch, 0.3, 1.2, 'RECT', 1, 48));
		pin++;
		out.push(pad(designator, String(pin), pin % 6 === 0 ? '3V3' : pin % 7 === 0 ? 'GND' : `P${pin}`, cxMm + half - (i + 0.5) * pitch, cyMm - half, 1.2, 0.3, 'RECT', 1, 48));
	}
	return out;
}

export function buildFixture(): BoardState {
	const pads: BoardPad[] = [];

	/* C1 0603：GND(1) / 3V3(2)，中心 (15,10) */
	pads.push(pad('C1', '1', 'GND', 14.2, 10, 0.9, 1.0));
	pads.push(pad('C1', '2', '3V3', 15.8, 10, 0.9, 1.0));

	/* U2 SOT-223：GND/3V3/VBUS + 3V3 散热焊盘，中心 (25,12) */
	pads.push(pad('U2', '1', 'GND', 22.7, 13, 1.2, 2.0));
	pads.push(pad('U2', '2', '3V3', 25, 13, 1.2, 2.0));
	pads.push(pad('U2', '3', 'VBUS', 27.3, 13, 1.2, 2.0));
	pads.push(pad('U2', '4', '3V3', 25, 11, 3.0, 2.0));

	/* J1 2 脚连接器：+5V / GND，中心 (35,10)，阻焊单边扩展 0.1mm（就近边界=阻焊开窗） */
	pads.push({ ...pad('J1', '1', '+5V', 34, 10, 2.0, 2.0, 'ELLIPSE'), maskExpansionMil: mm(0.1) });
	pads.push({ ...pad('J1', '2', 'GND', 36, 10, 2.0, 2.0, 'ELLIPSE'), maskExpansionMil: mm(0.1) });

	/* U1 LQFP48：中心 (30,30)，默认阈值下整体忽略 */
	pads.push(...lqfp48Pads('U1', 30, 30));

	/* B1 BGA-256：中心 (12,30)，整体忽略 */
	pads.push(...bgaPads('B1', 12, 30, 16, 0.8, 0.4));

	/* C9 板角 0603：1V8/GND，中心 (58.5,38.5) */
	pads.push(pad('C9', '1', '1V8', 57.7, 38.5, 0.9, 1.0));
	pads.push(pad('C9', '2', 'GND', 59.3, 38.5, 0.9, 1.0));

	/* R9 底层 0603：GND/3V3，中心 (25,25) */
	pads.push(pad('R9', '1', 'GND', 24.2, 25, 0.9, 1.0, 'RECT', 2));
	pads.push(pad('R9', '2', '3V3', 25.8, 25, 0.9, 1.0, 'RECT', 2));

	/* T1 顶层单焊盘 3V3 @ (45,20)；T2 底层单焊盘 GND @ (48,20)；
	 * T3 底层 2mm 方焊盘 GND @ (50,30)（同层走线挡连线场景） */
	pads.push(pad('T1', '1', '3V3', 45, 20, 1.0, 1.0, 'ELLIPSE', 1, 1));
	pads.push(pad('T2', '1', 'GND', 48, 20, 1.0, 1.0, 'ELLIPSE', 2, 1));
	pads.push(pad('T3', '1', 'GND', 50, 30, 2.0, 2.0, 'RECT', 2, 1));

	/* T4 板边压边焊盘 GND @ (-0.3, 5)：焊盘中心在板外，向板内方向仍应打出过孔 */
	pads.push(pad('T4', '1', 'GND', -0.3, 5, 0.9, 1.0, 'RECT', 1, 1));

	/* J2 直插 2P 端子：+12V / GND，多层(12)金属化孔、全孔、焊环完整
	 * （真直插：多层 + 器件全孔 + 孔塞得进焊盘三重甄别全过 -> 跳过不打） */
	pads.push({ ...pad('J2', '1', '+12V', 40, 30, 1.7, 1.7, 'ELLIPSE'), hasHole: true, holeExtentMil: mm(0.9), rawLayer: 12 });
	pads.push({ ...pad('J2', '2', 'GND', 41.27, 30, 1.7, 1.7, 'ELLIPSE'), hasHole: true, holeExtentMil: mm(0.9), rawLayer: 12 });

	/* 脏孔数据甄别器件组（板下沿 y=5 一排，模拟封装库残留孔数据）：
	 * - C20 0402 仅 2 号焊盘带大孔（0.76mm 塞不进 0.55mm 焊盘 -> 焊环甄别）
	 * - C21 0402 仅 2 号焊盘带小孔（0.2mm 几何放得进、多层(12)，但件内仅 1/2 带孔 -> 器件共识甄别）
	 * - H6 两焊盘全带放得进的孔但层=顶层单层（真直插必为多层 12 -> 单层甄别）
	 * - H7 两焊盘全带多层大孔（0.76mm 塞不进 0.75mm 焊盘 -> 焊环甄别）
	 * 均应按贴片处理照常打孔
	 */
	pads.push(pad('C20', '1', '3V3', 39.55, 5, 0.55, 0.65));
	pads.push({ ...pad('C20', '2', 'GND', 40.45, 5, 0.55, 0.65), hasHole: true, holeExtentMil: mm(0.76), rawLayer: 1 });
	pads.push(pad('C21', '1', '3V3', 42.05, 5, 0.55, 0.65));
	pads.push({ ...pad('C21', '2', 'GND', 42.95, 5, 0.55, 0.65), hasHole: true, holeExtentMil: mm(0.2), rawLayer: 12 });
	pads.push({ ...pad('H6', '1', 'GND', 45.4, 5, 0.65, 0.75), hasHole: true, holeExtentMil: mm(0.3), rawLayer: 1 });
	pads.push({ ...pad('H6', '2', '3V3', 46.6, 5, 0.65, 0.75), hasHole: true, holeExtentMil: mm(0.3), rawLayer: 1 });
	pads.push({ ...pad('H7', '1', 'GND', 49.4, 5, 0.65, 0.75), hasHole: true, holeExtentMil: mm(0.76), rawLayer: 12 });
	pads.push({ ...pad('H7', '2', '3V3', 50.6, 5, 0.65, 0.75), hasHole: true, holeExtentMil: mm(0.76), rawLayer: 12 });

	/* J3 混装连接器：2 个 GND 定位脚（多层真孔）+ 2 个信号 SMD 脚（无孔）——
	 * 件内仅部分焊盘带孔 -> 器件共识甄别按贴片处理（定位脚照常打孔） */
	pads.push({ ...pad('J3', '1', 'GND', 8, 15, 1.6, 1.6, 'ELLIPSE'), hasHole: true, holeExtentMil: mm(0.9), rawLayer: 12 });
	pads.push({ ...pad('J3', '2', 'GND', 11.5, 15, 1.6, 1.6, 'ELLIPSE'), hasHole: true, holeExtentMil: mm(0.9), rawLayer: 12 });
	pads.push(pad('J3', '3', 'DP', 9.5, 13.8, 0.6, 1.2));
	pads.push(pad('J3', '4', 'DM', 9.5, 16.2, 0.6, 1.2));

	/* 0402 去耦阵列 C11..C16（焊盘 0.55x0.65，中心距 0.9，排距 1.8）：
	 * 上下 1.0mm 处各一条异网络走线（IC 逃线区典型环境）——
	 * 默认 0.6mm 主过孔塞不下（8 方向阻塞），回退 0.2/0.4mm 小过孔可进 */
	for (let i = 0; i < 6; i++) {
		const x = 47 + i * 1.8;
		pads.push(pad(`C${10 + i + 1}`, '1', '3V3', x - 0.45, 33, 0.55, 0.65));
		pads.push(pad(`C${10 + i + 1}`, '2', 'GND', x + 0.45, 33, 0.55, 0.65));
	}

	/* 异网络既有走线（LED，0.2mm 宽，顶层；stub=0 时过孔边缘贴焊盘边界）：
	 * - 水平段 y=10.86 穿过 C1-3V3 斜向候选区（斜向仅后备）
	 * - T1(顶,圆 1mm)：竖段 x=45.55,y∈[20.30,20.50] 挡 0° 过孔；
	 *   横段 y=20.85,x∈[44.9,45.1] 挡 90° 过孔 -> 走 180° 直线
	 * - T2(底,圆 1mm)：竖段 x=48.55,y∈[20.30,20.50] 挡 0°；横段 y=20.85 挡 90°
	 *   -> 走 180°；竖段 x=47.90,y∈[19.95,20.05]（顶层）从下方穿过 T2 的
	 *   底层连线通道：若误做跨层连线检查会被挡，跨层应放行
	 * - T3(底,方 2mm)：底层竖段 x=50.65,y∈[29.9,30.1] 只挡 0° 连线通道
	 *   （过孔位置本身放行）；底层横段 y=31.05 挡 90° 过孔 -> 走 180°
	 *   （竖段从焊盘铜皮内穿过，为合成障碍几何，仅用于算法验证）
	 */
	const tracks: BoardTrack[] = [
		{ net: 'LED', layer: 1, x1: mm(15.5), y1: mm(10.86), x2: mm(17.5), y2: mm(10.86), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(45.55), y1: mm(20.30), x2: mm(45.55), y2: mm(20.50), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(44.9), y1: mm(20.85), x2: mm(45.1), y2: mm(20.85), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(48.55), y1: mm(20.30), x2: mm(48.55), y2: mm(20.50), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(47.9), y1: mm(20.85), x2: mm(48.1), y2: mm(20.85), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(47.90), y1: mm(19.95), x2: mm(47.90), y2: mm(20.05), width: mm(0.2) },
		{ net: 'LED', layer: 2, x1: mm(50.65), y1: mm(29.9), x2: mm(50.65), y2: mm(30.1), width: mm(0.2) },
		{ net: 'LED', layer: 2, x1: mm(49.9), y1: mm(31.05), x2: mm(50.1), y2: mm(31.05), width: mm(0.2) },
		// 0402 阵列上下逃线（距电容中心 1.0mm）：主过孔 0.6 塞不下，回退 0.4 可进
		{ net: 'LED', layer: 1, x1: mm(46), y1: mm(34.0), x2: mm(57.5), y2: mm(34.0), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(46), y1: mm(32.0), x2: mm(57.5), y2: mm(32.0), width: mm(0.2) },
		// 顶层大段无关走线（3V3 主干，同网络不构成障碍）
		{ net: '3V3', layer: 1, x1: mm(20), y1: mm(17), x2: mm(40), y2: mm(17), width: mm(0.5) },
	];

	/* 既有 GND 过孔：恰在 C1-GND 焊盘 135° 理想位置（13.34,10.86）-> 合并跳过 */
	const vias: BoardVia[] = [
		{ net: 'GND', x: mm(13.34), y: mm(10.86), diameter: mm(0.6) },
	];

	const points: Point[] = [
		{ x: 0, y: 0 },
		{ x: BOARD_W, y: 0 },
		{ x: BOARD_W, y: BOARD_H },
		{ x: 0, y: BOARD_H },
	];

	return {
		outline: { points, bbox: { minX: 0, minY: 0, maxX: BOARD_W, maxY: BOARD_H } },
		pads,
		vias,
		tracks,
	};
}

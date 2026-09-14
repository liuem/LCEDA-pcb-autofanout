import type { BoardPad, BoardState } from '../src/types.ts';
/** 0402 实测：不同间距/环境下能否打孔 */
import { planFanout } from '../src/planner.ts';
import { DEFAULT_CONFIG, MM_TO_MIL } from '../src/types.ts';

const mm = (v: number) => v * MM_TO_MIL;

function pad(d: string, p: string, net: string, x: number, y: number, w: number, h: number, pinCount = 2): BoardPad {
	return { compId: d, designator: d, padNumber: p, net, netClass: 'signal', x: mm(x), y: mm(y), sizeX: mm(w), sizeY: mm(h), shape: 'RECT', layer: 1, pinCount };
}

function run(label: string, pads: BoardPad[], cfg = DEFAULT_CONFIG): void {
	const state: BoardState = {
		outline: { points: [{ x: 0, y: 0 }, { x: mm(60), y: 0 }, { x: mm(60), y: mm(40) }, { x: 0, y: mm(40) }], bbox: { minX: 0, minY: 0, maxX: mm(60), maxY: mm(40) } },
		pads,
		vias: [],
		tracks: [],
	};
	const plan = planFanout(state, { ...cfg });
	console.log(`\n=== ${label} ===`);
	for (const it of plan.items)
		console.log(`${it.pad.designator}-${it.pad.padNumber} ${it.via.net} ${it.directionDeg}° step=${it.searchStep} via=${(it.via.diameter * 0.0254).toFixed(2)}mm`);
	for (const s of plan.skips)
		console.log(`${s.designator}-${s.padNumber} ${s.net} -> ${s.reason} ${s.detail ?? ''}`);
}

// 场景1：孤立 0402（3V3/GND），标准 1005M 焊盘 0.55x0.65，中心距 0.9
run('孤立 0402', [
	pad('C1', '1', '3V3', 10 - 0.45, 20, 0.55, 0.65),
	pad('C1', '2', 'GND', 10 + 0.45, 20, 0.55, 0.65),
]);

// 场景2：0402 去耦阵列 x6，真实排距（0402 庭院 ~1.5mm，取 1.8mm，3V3 同左侧）
const bank: BoardPad[] = [];
for (let i = 0; i < 6; i++) {
	const x = 10 + i * 1.8;
	bank.push(pad(`C${i + 1}`, '1', '3V3', x - 0.45, 20, 0.55, 0.65));
	bank.push(pad(`C${i + 1}`, '2', 'GND', x + 0.45, 20, 0.55, 0.65));
}
run('0402 去耦阵列 x6（排距 1.8mm）', bank);

// 场景2b：紧凑排距 1.6mm
const bank16: BoardPad[] = [];
for (let i = 0; i < 6; i++) {
	const x = 10 + i * 1.6;
	bank16.push(pad(`C${i + 1}`, '1', '3V3', x - 0.45, 20, 0.55, 0.65));
	bank16.push(pad(`C${i + 1}`, '2', 'GND', x + 0.45, 20, 0.55, 0.65));
}
run('0402 去耦阵列 x6（排距 1.6mm）', bank16);

// 场景3：阵列上下各一条异网络走线（距电容中心 0.9mm，模拟 IC 引脚逃线）
const withTracks: BoardState = {
	outline: { points: [{ x: 0, y: 0 }, { x: mm(60), y: 0 }, { x: mm(60), y: mm(40) }, { x: 0, y: mm(40) }], bbox: { minX: 0, minY: 0, maxX: mm(60), maxY: mm(40) } },
	pads: bank,
	vias: [],
	tracks: [
		{ net: 'LED', layer: 1, x1: mm(8), y1: mm(20.9), x2: mm(20), y2: mm(20.9), width: mm(0.2) },
		{ net: 'LED', layer: 1, x1: mm(8), y1: mm(19.1), x2: mm(20), y2: mm(19.1), width: mm(0.2) },
	],
};
{
	const plan = planFanout(withTracks, { ...DEFAULT_CONFIG });
	console.log('\n=== 阵列 1.8mm + 上下走线（0.9mm 处）===');
	for (const it of plan.items)
		console.log(`${it.pad.designator}-${it.pad.padNumber} ${it.via.net} ${it.directionDeg}° step=${it.searchStep}`);
	for (const s of plan.skips)
		console.log(`${s.designator}-${s.padNumber} ${s.net} -> ${s.reason}`);
}

// 场景4：紧凑 1.6mm 换小过孔 0.2/0.4
run('1.6mm 排距，过孔 0.2/0.4mm', bank16, { ...DEFAULT_CONFIG, viaHoleMm: 0.2, viaDiameterMm: 0.4 });

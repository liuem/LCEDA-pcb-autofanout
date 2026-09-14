/** 调试：dump 每个焊盘的规划结果与跳过原因 */
import { planFanout } from '../src/planner.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import { buildFixture } from './fixture.ts';

const mil2mm = (v: number) => (v * 0.0254).toFixed(2);

const plan = planFanout(buildFixture(), { ...DEFAULT_CONFIG });
console.log('=== items ===');
for (const it of plan.items) {
	console.log(
		`${it.pad.designator}-${it.pad.padNumber} ${it.via.net} dir=${it.directionDeg}° step=${it.searchStep} via=(${mil2mm(it.via.x)},${mil2mm(it.via.y)})mm dist=${mil2mm(it.distanceMil)}mm w=${mil2mm(it.track.width)}mm layer=${it.track.layer}`,
	);
}
console.log('\n=== skips ===');
for (const s of plan.skips)
	console.log(`${s.designator}-${s.padNumber} ${s.net} ${s.reason} ${s.detail ?? ''}`);
console.log('\n=== stats ===', plan.stats);
console.log('ignored:', plan.ignoredComps);

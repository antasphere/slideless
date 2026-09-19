import { createPlatform } from '@antasphere/chassis-server';
import { slidelessTool, type SlidelessBootOverrides, type SlidelessBootResult } from './tool.js';

/**
 * The Slideless boot: the chassis' locked composition (`createPlatform`,
 * `@antasphere/chassis-server`) bound to the Slideless tool definition
 * (`tool.ts`). The sequence itself — env → logger → db probe → secret →
 * migrations under advisory lock → app assembly → ready — lives in the chassis.
 */
const platform = createPlatform(slidelessTool);

/** Test seams only — production boot never passes overrides. */
export type BootOverrides = SlidelessBootOverrides;
export type BootResult = SlidelessBootResult;

export const boot = (source?: NodeJS.ProcessEnv, overrides?: BootOverrides): Promise<BootResult> =>
  platform.boot(source, overrides);

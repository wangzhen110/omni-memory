// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * One concurrent writer, used by concurrency.test.mjs.
 *
 * Spawned as a real process on purpose: the question is not whether the code
 * handles parallelism in one event loop, but whether several OS processes
 * sharing one SQLite file can write without losing rows.
 *
 *   node worker.mjs <label> <count> <unique|same>
 */

import { bootHost } from '../../hosts/shared/boot.mjs';

const label = process.argv[2] ?? 'w';
const count = Number(process.argv[3] ?? 5);
const mode = process.argv[4] ?? 'unique';

const booted = await bootHost({ workdir: process.cwd() });
const write = booted.host.tools.get('memory_write');
if (!write) throw new Error('memory_write missing');

for (let index = 0; index < count; index += 1) {
  const text = mode === 'same'
    ? 'concurrent identical note'
    : `concurrent note ${label}-${index}`;
  await write.execute(
    { kind: 'note', text, scope: 'global', importance: 0.1, source: `test:${label}` },
    booted.toolContext,
  );
}

booted.host.dispose();

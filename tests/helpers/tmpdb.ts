/**
 * 必须在任何会 import `src/db.js` 的模块**之前**被 import。
 * ESM 按 import 顺序求值依赖，所以把这一行放在测试文件的第一条 import 即可。
 *
 * 目的：测试绝不读写日常运行的 data/fomot.db。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.FOMOT_DB) {
  process.env.FOMOT_DB = join(mkdtempSync(join(tmpdir(), 'fomot-test-')), 'test.db');
}
// 测试永远跑在禁发送模式下
process.env.NOTIFY_MODE = 'off';
export const TEST_DB = process.env.FOMOT_DB;

#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Build the Windows GUI launcher reproducibly.
 *
 * The old csc compiler embeds the wall-clock PE timestamp and a random module
 * MVID. Both are normalized after compiling so the same source and output name
 * produce the same SHA-256. `--check` rebuilds in a temp directory and fails if
 * the committed binary differs from the source.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'scripts', 'launchers', 'omni-serve-7788-launcher.cs');
const OUTPUT = path.join(ROOT, 'scripts', 'launchers', 'omni-serve-7788.exe');
const CSC = process.env.CSC_BIN || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SYSTEM_MANAGEMENT = process.env.SYSTEM_MANAGEMENT_DLL
  || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Management.dll';
const CHECK = process.argv.includes('--check');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function rvaToOffset(bytes, sections, rva) {
  for (const section of sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside the PE sections`);
}

function findModuleMvid(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const cliRva = bytes.readUInt32LE(directories + 14 * 8);
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40;
    sections.push({
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawPointer: bytes.readUInt32LE(offset + 20),
    });
  }
  const cli = rvaToOffset(bytes, sections, cliRva);
  const metadataRva = bytes.readUInt32LE(cli + 8);
  const metadata = rvaToOffset(bytes, sections, metadataRva);
  const versionLength = bytes.readUInt32LE(metadata + 12);
  const streamCount = bytes.readUInt16LE(metadata + 16 + versionLength + 2);
  let stream = metadata + 16 + versionLength + 4;
  for (let index = 0; index < streamCount; index += 1) {
    const relativeOffset = bytes.readUInt32LE(stream);
    const size = bytes.readUInt32LE(stream + 4);
    let nameEnd = stream + 8;
    while (nameEnd < stream + 8 + 32 && bytes[nameEnd] !== 0) nameEnd += 1;
    const name = bytes.subarray(stream + 8, nameEnd).toString('ascii');
    if (name === '#GUID') {
      if (size < 16) throw new Error('#GUID stream is shorter than one MVID');
      return metadata + relativeOffset;
    }
    stream = stream + 8 + ((nameEnd - (stream + 8) + 1 + 3) & ~3);
  }
  throw new Error('PE metadata has no #GUID stream');
}

function normalizePe(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  // A fixed timestamp removes the wall-clock byte. Zero is legal in PE/COFF.
  bytes.writeUInt32LE(0, pe + 8);
  const mvid = findModuleMvid(bytes);
  // The module MVID is random in the classic csc compiler. A fixed MVID is
  // safe for this deliberately single-purpose executable.
  bytes.fill(0, mvid, mvid + 16);
  return bytes;
}

function compileOnce(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `omni-launcher-${label}-`));
  const output = path.join(dir, 'omni-serve-7788.exe');
  try {
    if (!existsSync(CSC)) throw new Error(`csc not found: ${CSC}`);
    if (!existsSync(SYSTEM_MANAGEMENT)) throw new Error(`System.Management.dll not found: ${SYSTEM_MANAGEMENT}`);
    const result = spawnSync(CSC, [
      '/nologo',
      '/target:winexe',
      '/codepage:65001',
      `/r:${SYSTEM_MANAGEMENT}`,
      `/out:${output}`,
      SOURCE,
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`csc failed with ${result.status}: ${String(result.stderr || result.stdout).trim()}`);
    }
    const bytes = readFileSync(output);
    return normalizePe(bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'win32' && !existsSync(CSC)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'csc is only available on Windows' }));
    return;
  }
  const first = compileOnce('one');
  const firstHash = sha256(first);
  if (CHECK) {
    if (!existsSync(OUTPUT)) throw new Error(`committed launcher missing: ${OUTPUT}`);
    const committed = readFileSync(OUTPUT);
    const committedHash = sha256(committed);
    if (committedHash !== firstHash) {
      throw new Error(`launcher binary is stale: committed ${committedHash}, rebuilt ${firstHash}`);
    }
    console.log(JSON.stringify({ ok: true, checked: true, sha256: firstHash, bytes: first.length }));
    return;
  }
  const second = compileOnce('two');
  const secondHash = sha256(second);
  if (firstHash !== secondHash) {
    throw new Error(`launcher build is not reproducible: ${firstHash} != ${secondHash}`);
  }
  writeFileSync(OUTPUT, first, { mode: 0o644 });
  console.log(JSON.stringify({ ok: true, out: OUTPUT, sha256: firstHash, bytes: first.length }));
}

try {
  main();
} catch (error) {
  console.error(`launcher build failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}

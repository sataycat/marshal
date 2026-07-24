import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const originalMarshalHome = process.env.MARSHAL_HOME;
let marshalHome: string;
const marshalHomes: string[] = [];

beforeEach(() => {
  marshalHome = mkdtempSync(join(tmpdir(), "marshal-vitest-home-"));
  marshalHomes.push(marshalHome);
  process.env.MARSHAL_HOME = marshalHome;
});

afterAll(() => {
  for (const path of marshalHomes) rmSync(path, { recursive: true, force: true });
  if (originalMarshalHome === undefined) delete process.env.MARSHAL_HOME;
  else process.env.MARSHAL_HOME = originalMarshalHome;
});

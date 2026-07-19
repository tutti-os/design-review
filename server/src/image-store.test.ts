import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BadRequestError } from "./errors.js";
import { validateImagePath } from "./image-store.js";

async function withImageFixture(
  run: (fixture: {
    dataDir: string;
    externalDir: string;
    root: string;
    runtimeDir: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "design-review-image-"));
  const dataDir = path.join(root, "data");
  const runtimeDir = path.join(root, "runtime");
  const externalDir = path.join(root, "external");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(externalDir, { recursive: true }),
  ]);
  try {
    await run({ dataDir, externalDir, root, runtimeDir });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("validateImagePath accepts staged runtime/data images", async () => {
  await withImageFixture(async ({ dataDir, runtimeDir }) => {
    const image = path.join(runtimeDir, "screen.png");
    await writeFile(image, "image");

    assert.equal(
      await validateImagePath(image, [runtimeDir, dataDir]),
      await realpath(image),
    );
  });
});

test("validateImagePath rejects external images", async () => {
  await withImageFixture(async ({ dataDir, externalDir, runtimeDir }) => {
    const image = path.join(externalDir, "screen.png");
    await writeFile(image, "image");

    await assert.rejects(
      validateImagePath(image, [runtimeDir, dataDir]),
      BadRequestError,
    );
  });
});

test("validateImagePath rejects parent traversal outside staged directories", async () => {
  await withImageFixture(async ({ dataDir, externalDir, runtimeDir }) => {
    await mkdir(path.join(runtimeDir, "nested"));
    await writeFile(path.join(externalDir, "screen.png"), "image");
    const traversal = `${runtimeDir}${path.sep}nested${path.sep}..${path.sep}..${path.sep}external${path.sep}screen.png`;

    await assert.rejects(
      validateImagePath(traversal, [runtimeDir, dataDir]),
      BadRequestError,
    );
  });
});

test("validateImagePath rejects symlinks to external images", async () => {
  await withImageFixture(async ({ dataDir, externalDir, runtimeDir }) => {
    const externalImage = path.join(externalDir, "screen.png");
    const link = path.join(runtimeDir, "screen.png");
    await writeFile(externalImage, "image");
    await symlink(externalImage, link);

    await assert.rejects(
      validateImagePath(link, [runtimeDir, dataDir]),
      BadRequestError,
    );
  });
});

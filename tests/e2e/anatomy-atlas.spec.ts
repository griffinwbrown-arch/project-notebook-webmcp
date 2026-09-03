import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADULT_SKELETON_BONES, ANATOMY_CATALOG_VERSION, ANATOMY_SECTIONS, bonesForSection } from "../../src/anatomy";
import {
  ATLAS_PATH,
  EXPECTED_ATLAS_BYTES,
  EXPECTED_ATLAS_SHA256,
  EXPECTED_ANATOMY_TOOLS,
  EXPECTED_LOGICAL_BONES,
  EXPECTED_SEMANTIC_MESHES,
  createAtlasNotebook,
  executeTool,
  expectNoBrowserErrors,
  installAnatomyAcceptanceBridge,
  isRecord,
  observeBrowser,
  requiredNumber,
  requiredRecord,
  requiredString,
  waitForAtlasReady,
  waitForTools,
  writeEvidence,
} from "./anatomy-atlas-helpers";

test.skip(process.env.ANATOMY_ACCEPTANCE_RUN !== "1", "Run through test:anatomy:acceptance with the pinned external atlas.");

const PELVIS = bonesForSection("pelvis");
const PELVIS_SECRETS = [...new Set(PELVIS.flatMap((bone) => [
  bone.id,
  bone.name,
  ...bone.acceptedAnswers,
  ...bone.sourceObjects,
]))].filter((secret) => secret.length >= 4);

function fieldRecord(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): Readonly<Record<string, unknown>> {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  throw new Error(`Expected one of ${keys.join(", ")} to be an object in ${JSON.stringify(record)}.`);
}

function optionalFieldRecord(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  for (const key of keys) {
    const value = record[key];
    if (value === null) return null;
    if (isRecord(value)) return value;
  }
  return null;
}

function secretMatches(value: unknown): string[] {
  const text = (typeof value === "string" ? value : JSON.stringify(value)).toLocaleLowerCase();
  return PELVIS_SECRETS.filter((secret) => text.includes(secret.toLocaleLowerCase()));
}

async function anatomyContext(page: Page): Promise<Readonly<Record<string, unknown>>> {
  return executeTool(page, "anatomy_context_read", {});
}

async function waitForSelectedBone(page: Page, expectedBoneId: string): Promise<Readonly<Record<string, unknown>>> {
  let latest: Readonly<Record<string, unknown>> = {};
  await expect.poll(async () => {
    latest = await anatomyContext(page);
    const selected = optionalFieldRecord(latest, "selected_bone", "selectedBone");
    return selected === null ? null : selected.id;
  }, { message: `The atlas did not select ${expectedBoneId}.`, timeout: 12_000 }).toBe(expectedBoneId);
  return latest;
}

async function waitForCameraSettled(page: Page): Promise<void> {
  let previous = "";
  let stableSamples = 0;
  await expect.poll(async () => {
    const camera = fieldRecord(await anatomyContext(page), "camera");
    const current = JSON.stringify({ position: camera.position, distance: camera.distance });
    stableSamples = current === previous ? stableSamples + 1 : 0;
    previous = current;
    return stableSamples;
  }, {
    message: "The atlas camera did not settle after focusing a source mesh.",
    timeout: 3_000,
    intervals: [50],
  }).toBeGreaterThanOrEqual(3);
}

async function findProjectedMeshPoint(page: Page, expectedBoneId: string): Promise<Readonly<{ x: number; y: number }>> {
  const hotspot = page.locator(".anatomy-hotspot-label");
  await expect(hotspot).toBeVisible();
  const anchor = await hotspot.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("The hotspot label is not an HTML element.");
    const stage = element.closest(".anatomy-model-stage")?.getBoundingClientRect();
    if (stage === undefined) throw new Error("The hotspot label is not inside the model stage.");
    const parsePosition = (value: string, size: number): number => value.endsWith("%")
      ? Number.parseFloat(value) * size / 100
      : Number.parseFloat(value);
    return {
      x: stage.x + parsePosition(element.style.left, stage.width),
      y: stage.y + parsePosition(element.style.top, stage.height),
      label: element.getBoundingClientRect().toJSON(),
      pointerEvents: getComputedStyle(element).pointerEvents,
    };
  });
  const label = anchor.label;
  const offsets: (readonly [number, number])[] = [[0, 0]];
  for (const radius of [8, 16, 24, 32, 48, 64, 80, 96, 120]) {
    for (let index = 0; index < 16; index += 1) {
      const angle = index / 16 * Math.PI * 2;
      offsets.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
  }
  for (const [offsetX, offsetY] of offsets) {
    const point = { x: anchor.x + offsetX, y: anchor.y + offsetY };
    const insideLabel = point.x >= label.x && point.x <= label.x + label.width &&
      point.y >= label.y && point.y <= label.y + label.height;
    if (insideLabel && anchor.pointerEvents !== "none") continue;
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(34);
    const context = await anatomyContext(page);
    const hovered = optionalFieldRecord(context, "hovered_bone", "hoveredBone");
    if (hovered?.id === expectedBoneId) return point;
  }
  throw new Error(`A real pointer raycast did not hit ${expectedBoneId} around its projected source mesh.`);
}

async function expectMinimumTarget(locator: Locator, minimum: number, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label} must be visible.`).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} has no measurable hit target.`);
  expect(box.width, `${label} must be at least ${minimum}px wide.`).toBeGreaterThanOrEqual(minimum);
  expect(box.height, `${label} must be at least ${minimum}px high.`).toBeGreaterThanOrEqual(minimum);
}

async function verifyEveryStudyMapping(page: Page): Promise<readonly Readonly<{
  id: string;
  expectedName: string;
  observedId: unknown;
  observedName: unknown;
  expectedSourceObjects: readonly string[];
  observedSourceObjects: unknown;
  expectedMeshParts: number;
  observedMeshParts: unknown;
}>[]> {
  const expectedBones = ADULT_SKELETON_BONES.map((bone) => ({
    id: bone.id,
    name: bone.name,
    sourceObjects: bone.sourceObjects,
    sourceMeshCount: bone.sourceMeshCount,
  }));
  return page.evaluate(async (bones) => {
    const asRecord = (value: unknown): Record<string, unknown> | null =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const unwrap = (value: unknown): Record<string, unknown> => {
      const record = asRecord(value);
      if (record === null) throw new Error("An anatomy tool returned a non-object result.");
      if (record.outcome === "error") throw new Error(JSON.stringify(record.error));
      const output = asRecord(record.output);
      if (record.outcome === "success" && output !== null) return output;
      return asRecord(record.structuredContent) ?? record;
    };
    const results = [];
    for (const bone of bones) {
      unwrap(await window.__anatomyAcceptance.invoke("anatomy_navigate", { action: "focus", boneId: bone.id }));
      let selected: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const context = unwrap(await window.__anatomyAcceptance.invoke("anatomy_context_read", {}));
        selected = asRecord(context.selected_bone) ?? asRecord(context.selectedBone);
        if (selected?.id === bone.id) break;
      }
      results.push({
        id: bone.id,
        expectedName: bone.name,
        observedId: selected?.id ?? null,
        observedName: selected?.label ?? null,
        expectedSourceObjects: bone.sourceObjects,
        observedSourceObjects: selected?.source_objects ?? null,
        expectedMeshParts: bone.sourceMeshCount,
        observedMeshParts: selected?.mesh_parts ?? null,
      });
    }
    return results;
  }, expectedBones);
}

async function measureRenderedSkeleton(page: Page, canvas: Locator, path: string): Promise<Readonly<{
  imageWidth: number;
  imageHeight: number;
  foregroundPixels: number;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }> | null;
  samplePoints: readonly Readonly<{ x: number; y: number }>[];
}>> {
  const visualMaskId = `anatomy-visual-mask-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await canvas.evaluate((element, id) => {
    const style = element.ownerDocument.createElement("style");
    style.id = id;
    style.textContent = [
      ".anatomy-model-stage > :not(.anatomy-model-canvas) { visibility: hidden !important; }",
      ".anatomy-model-stage::after { display: none !important; }",
      ".page-controls { visibility: hidden !important; }",
    ].join("\n");
    element.ownerDocument.head.append(style);
  }, visualMaskId);
  let png: Buffer;
  try {
    png = await canvas.screenshot({ path, animations: "disabled" });
  } finally {
    await canvas.evaluate((element, id) => element.ownerDocument.getElementById(id)?.remove(), visualMaskId);
  }
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const scratch = document.createElement("canvas");
    scratch.width = bitmap.width;
    scratch.height = bitmap.height;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("Chromium did not provide a 2D image context.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
    let left = scratch.width;
    let right = -1;
    let top = scratch.height;
    let bottom = -1;
    let foregroundPixels = 0;
    const foregroundPoints: { x: number; y: number }[] = [];
    const compositorGutter = 4;
    for (let y = compositorGutter; y < scratch.height - compositorGutter; y += 1) {
      for (let x = compositorGutter; x < scratch.width - compositorGutter; x += 1) {
        const offset = (y * scratch.width + x) * 4;
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        if (luminance < 110) continue;
        foregroundPixels += 1;
        foregroundPoints.push({ x, y });
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    const centerX = foregroundPoints.reduce((sum, point) => sum + point.x, 0) / Math.max(1, foregroundPoints.length);
    const centerY = foregroundPoints.reduce((sum, point) => sum + point.y, 0) / Math.max(1, foregroundPoints.length);
    const samplePoints = foregroundPoints
      .filter((_, index) => index % 5 === 0)
      .sort((leftPoint, rightPoint) =>
        Math.hypot(leftPoint.x - centerX, leftPoint.y - centerY) -
        Math.hypot(rightPoint.x - centerX, rightPoint.y - centerY))
      .slice(0, 48);
    return {
      imageWidth: scratch.width,
      imageHeight: scratch.height,
      foregroundPixels,
      bounds: right < left || bottom < top
        ? null
        : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
      samplePoints,
    };
  }, png.toString("base64"));
}

test.beforeEach(async ({ context }) => {
  await installAnatomyAcceptanceBridge(context);
});

test("@desktop creates seven anatomy pages and proves source-mesh study, test, coloring, fit, and remount safety", async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe("anatomy-desktop");
  const issues = observeBrowser(page);
  const title = "Anatomy exam prep acceptance";
  const notebook = await createAtlasNotebook(page, title);
  await waitForAtlasReady(page);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);

  const root = page.locator('.anatomy-study-card[data-atlas-state="ready"]');
  await expect(root).toHaveAttribute("data-logical-bones", String(EXPECTED_LOGICAL_BONES));
  await expect(root).toHaveAttribute("data-semantic-meshes", String(EXPECTED_SEMANTIC_MESHES));
  await expect(root.locator(".anatomy-study-footer")).toContainText("206 identities · 208 source meshes verified · 3 agent controls");
  const atlasCanvas = root.locator(".anatomy-model-canvas canvas");
  await expect(atlasCanvas, "The validated atlas must explicitly report upright normalization.")
    .toHaveAttribute("data-atlas-upright", "true");
  const normalizedDimensions = (await atlasCanvas.getAttribute("data-atlas-dimensions"))
    ?.split(",")
    .map((value) => Number.parseFloat(value));
  expect(normalizedDimensions, "The atlas must publish measurable normalized dimensions.").toHaveLength(3);
  if (normalizedDimensions === undefined || normalizedDimensions.some((value) => !Number.isFinite(value))) {
    throw new Error("The atlas published invalid normalized dimensions.");
  }
  const [width, height, depth] = normalizedDimensions;
  if (width === undefined || height === undefined || depth === undefined) {
    throw new Error("The atlas did not publish width, height, and depth.");
  }
  expect(height, "The atlas height must exceed its width after upright normalization.").toBeGreaterThan(width);
  expect(height, "The atlas height must exceed its depth after upright normalization.").toBeGreaterThan(depth);
  const uprightRendering = await measureRenderedSkeleton(page, atlasCanvas, testInfo.outputPath("atlas-upright-anterior.png"));
  expect(uprightRendering.foregroundPixels, "The anterior visual proof must contain rendered skeleton geometry.")
    .toBeGreaterThan(2_000);
  expect(uprightRendering.bounds).not.toBeNull();
  if (uprightRendering.bounds === null) throw new Error("The anterior skeleton had no measurable bright-pixel bounds.");
  expect(uprightRendering.bounds.height, "The rendered skeleton must be visibly upright, not sideways.")
    .toBeGreaterThan(uprightRendering.bounds.width * 1.35);

  const servedAtlas = await page.evaluate(async ({ expectedPath }) => {
    const response = await fetch(expectedPath);
    const body = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", body);
    const view = new DataView(body);
    const jsonLength = view.getUint32(12, true);
    const jsonType = view.getUint32(16, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 20, jsonLength)).replaceAll("\u0000", "")) as {
      nodes?: readonly Readonly<{ name?: unknown; mesh?: unknown; extras?: Readonly<Record<string, unknown>> }>[];
    };
    const semanticNodes = (json.nodes ?? []).flatMap((node) => {
      const extras = node.extras;
      if (extras === undefined || typeof extras.boneId !== "string") return [];
      return [{
        nodeName: node.name ?? null,
        mesh: node.mesh ?? null,
        boneId: extras.boneId,
        anatomyLabel: extras.anatomyLabel ?? null,
        anatomySection: extras.anatomySection ?? null,
        catalogVersion: extras.catalogVersion ?? null,
        semanticAuthority: extras.semanticAuthority ?? null,
      }];
    });
    return {
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      bytes: body.byteLength,
      sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
      glb: {
        magic: view.getUint32(0, true),
        version: view.getUint32(4, true),
        declaredBytes: view.getUint32(8, true),
        jsonType,
        nodeCount: json.nodes?.length ?? 0,
        semanticNodes,
      },
    };
  }, { expectedPath: ATLAS_PATH });
  expect(servedAtlas.ok, "The pinned atlas route must return successfully.").toBe(true);
  expect(servedAtlas.contentType).toContain("model/gltf-binary");
  expect(servedAtlas.bytes, "The notebook must receive the exact pinned atlas byte length.").toBe(EXPECTED_ATLAS_BYTES);
  expect(servedAtlas.sha256, "The notebook must receive the exact pinned atlas bytes.").toBe(EXPECTED_ATLAS_SHA256);
  expect(servedAtlas.glb).toMatchObject({
    magic: 0x46546c67,
    version: 2,
    declaredBytes: EXPECTED_ATLAS_BYTES,
    jsonType: 0x4e4f534a,
    nodeCount: EXPECTED_SEMANTIC_MESHES,
  });
  expect(servedAtlas.glb.semanticNodes).toHaveLength(EXPECTED_SEMANTIC_MESHES);
  const glbMappingMismatches = ADULT_SKELETON_BONES.flatMap((bone) => {
    const nodes = servedAtlas.glb.semanticNodes.filter((node) => node.boneId === bone.id);
    const valid = nodes.length === bone.sourceMeshCount && nodes.every((node, index) =>
      node.nodeName === `bone:${bone.id}:${index + 1}` &&
      typeof node.mesh === "number" &&
      node.anatomyLabel === bone.name &&
      node.anatomySection === bone.section &&
      node.catalogVersion === ANATOMY_CATALOG_VERSION &&
      node.semanticAuthority === "Z-Anatomy source mesh");
    return valid ? [] : [{ bone, nodes }];
  });
  expect(new Set(servedAtlas.glb.semanticNodes.map((node) => node.boneId)).size).toBe(EXPECTED_LOGICAL_BONES);
  expect(glbMappingMismatches, "Independent GLB parsing must match all 206 catalog identities and 208 mesh parts.").toEqual([]);
  const anatomyToolNames = (await page.evaluate(() => window.__anatomyAcceptance.names()))
    .filter((name) => name.startsWith("anatomy_"));
  expect(anatomyToolNames, "The notebook component must publish only its three bounded anatomy tools.")
    .toEqual([...EXPECTED_ANATOMY_TOOLS]);
  const descriptors = await page.evaluate(() => window.__anatomyAcceptance.descriptors());
  for (const toolName of EXPECTED_ANATOMY_TOOLS) {
    const descriptor = descriptors.find((candidate) => candidate.name === toolName);
    expect(descriptor, `${toolName} must have a discoverable descriptor.`).toBeDefined();
    expect(descriptor?.inputSchema, `${toolName} must publish an input schema.`).toBeTruthy();
  }
  const firstMountRegistrations = await page.evaluate(() => window.__anatomyAcceptance.registrationCounts());
  expect(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, firstMountRegistrations[name]])),
    "Each bounded anatomy tool must register exactly once for the model context.")
    .toEqual(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, 1])));

  const initialContext = await anatomyContext(page);
  expect(ADULT_SKELETON_BONES).toHaveLength(EXPECTED_LOGICAL_BONES);
  expect(new Set(ADULT_SKELETON_BONES.map((bone) => bone.id)).size).toBe(EXPECTED_LOGICAL_BONES);
  expect(ADULT_SKELETON_BONES.reduce((total, bone) => total + bone.sourceMeshCount, 0))
    .toBe(EXPECTED_SEMANTIC_MESHES);
  expect(ADULT_SKELETON_BONES.every((bone) => bone.sourceObjects.length === bone.sourceMeshCount)).toBe(true);
  const integrity = fieldRecord(initialContext, "integrity");
  expect(integrity.semantic_identity_verified).toBe(true);
  expect(integrity.catalog_ids_match).toBe(true);
  expect(integrity.upright).toBe(true);
  expect(integrity.normalized_dimensions).toEqual(expect.any(Array));
  expect(integrity.model_dimensions).toEqual(expect.objectContaining({
    width: expect.any(Number),
    height: expect.any(Number),
    depth: expect.any(Number),
  }));
  expect(requiredNumber(initialContext, "logicalBoneCount")).toBe(EXPECTED_LOGICAL_BONES);
  expect(requiredNumber(initialContext, "semanticMeshNodeCount")).toBe(EXPECTED_SEMANTIC_MESHES);
  const initialBone = fieldRecord(initialContext, "selected_bone", "selectedBone");
  expect(requiredString(initialBone, "id")).toBe("sternum");
  expect(requiredNumber(initialBone, "mesh_parts")).toBe(3);

  const semanticInventory = await verifyEveryStudyMapping(page);
  const mappingMismatches = semanticInventory.filter((mapping) =>
    mapping.observedId !== mapping.id ||
    mapping.observedName !== mapping.expectedName ||
    JSON.stringify(mapping.observedSourceObjects) !== JSON.stringify(mapping.expectedSourceObjects) ||
    mapping.observedMeshParts !== mapping.expectedMeshParts);
  expect(semanticInventory, "The browser must exercise every logical bone identity.").toHaveLength(EXPECTED_LOGICAL_BONES);
  expect(mappingMismatches, "Every focused identity must resolve to its exact source-owned bone and mesh parts.").toEqual([]);

  const visibleCatalogLabels = [];
  for (const anatomySection of ANATOMY_SECTIONS) {
    await executeTool(page, "anatomy_navigate", { action: "set_view", section: anatomySection.id });
    const expectedBones = bonesForSection(anatomySection.id);
    const options = root.locator('.anatomy-bone-list [role="option"]');
    await expect(options).toHaveCount(expectedBones.length);
    const labels = await options.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
    const missing = expectedBones.filter((bone) => !labels.some((label) => label.includes(bone.name)));
    expect(missing, `The ${anatomySection.id} browser must show every exact catalog label.`).toEqual([]);
    visibleCatalogLabels.push({ section: anatomySection.id, labels });
  }

  const raycastRepresentatives = [
    { section: "skull", boneId: "mandible" },
    { section: "vertebral-column", boneId: "atlas-c1" },
    { section: "thorax", boneId: "sternum" },
    { section: "upper-limb", boneId: "left-humerus" },
    { section: "pelvis", boneId: "left-hip-bone" },
    { section: "lower-limb", boneId: "left-patella" },
  ] as const;
  const sectionRaycasts = [];
  for (const representative of raycastRepresentatives) {
    await executeTool(page, "anatomy_navigate", { action: "set_view", section: representative.section });
    await executeTool(page, "anatomy_navigate", { action: "focus", boneId: representative.boneId, isolate: true });
    await waitForSelectedBone(page, representative.boneId);
    await waitForCameraSettled(page);
    const isolatedMapping = await anatomyContext(page);
    expect(isolatedMapping.isolated).toBe(true);
    expect(requiredNumber(isolatedMapping, "visibleSemanticMeshCount")).toBe(
      ADULT_SKELETON_BONES.find((bone) => bone.id === representative.boneId)?.sourceMeshCount,
    );
    const point = await findProjectedMeshPoint(page, representative.boneId);
    await page.mouse.click(point.x, point.y);
    await waitForSelectedBone(page, representative.boneId);
    sectionRaycasts.push({ ...representative, point });
    await executeTool(page, "anatomy_navigate", { action: "focus", boneId: representative.boneId, isolate: false });
  }
  await waitForCameraSettled(page);
  const raycastPoint = await findProjectedMeshPoint(page, "left-patella");
  await page.mouse.click(raycastPoint.x, raycastPoint.y);
  const clickedContext = await waitForSelectedBone(page, "left-patella");
  expect(fieldRecord(clickedContext, "selected_bone", "selectedBone").source_objects).toEqual(["Patella.l"]);

  const canvas = atlasCanvas;
  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) throw new Error("The model canvas has no measurable bounds.");
  const cameraBeforeDrag = fieldRecord(await anatomyContext(page), "camera");
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.72, canvasBox.y + canvasBox.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.56, canvasBox.y + canvasBox.height * 0.38, { steps: 18 });
  await page.mouse.up();
  const cameraAfterDrag = fieldRecord(await anatomyContext(page), "camera");
  expect(cameraAfterDrag.position, "A real drag must change the camera position.").not.toEqual(cameraBeforeDrag.position);
  expect(cameraAfterDrag.view, "A user orbit must leave the fixed camera preset.").toBe("custom");
  const distanceBeforeZoom = requiredNumber(cameraAfterDrag, "distance");
  await canvas.hover({ position: { x: canvasBox.width * 0.5, y: canvasBox.height * 0.5 } });
  await page.mouse.wheel(0, -640);
  await expect.poll(async () => requiredNumber(fieldRecord(await anatomyContext(page), "camera"), "distance"))
    .not.toBe(distanceBeforeZoom);

  const cameraControls = root.getByRole("group", { name: "Skeleton camera and visibility controls" });
  const cameraBeforeFocus = fieldRecord(await anatomyContext(page), "camera");
  await cameraControls.getByRole("button", { name: "Focus" }).click();
  await expect.poll(async () => fieldRecord(await anatomyContext(page), "camera").position,
    { message: "Focus must move the real atlas camera to the selected mesh bounds." })
    .not.toEqual(cameraBeforeFocus.position);
  await cameraControls.getByRole("button", { name: "Isolate" }).click();
  await expect(cameraControls.getByRole("button", { name: "Show all" })).toBeVisible();
  const isolatedContext = await anatomyContext(page);
  expect(isolatedContext.isolated).toBe(true);
  expect(requiredNumber(isolatedContext, "visibleSemanticMeshCount"),
    "Isolate must leave only the selected patella source mesh visible.").toBe(1);
  await cameraControls.getByRole("button", { name: "Show all" }).click();
  const restoredContext = await anatomyContext(page);
  expect(restoredContext.isolated).toBe(false);
  expect(requiredNumber(restoredContext, "visibleSemanticMeshCount"),
    "Show all must restore every verified source mesh.").toBe(EXPECTED_SEMANTIC_MESHES);
  const cameraBeforeLeft = fieldRecord(restoredContext, "camera");
  await executeTool(page, "anatomy_navigate", { action: "set_view", camera: "left" });
  await expect(cameraControls.getByRole("button", { name: "Left" })).toHaveAttribute("aria-pressed", "true");
  const leftCamera = fieldRecord(await anatomyContext(page), "camera");
  expect(leftCamera.view).toBe("left");
  expect(leftCamera.position).not.toEqual(cameraBeforeLeft.position);
  await cameraControls.getByRole("button", { name: "Anterior" }).click();
  await expect(cameraControls.getByRole("button", { name: "Anterior" })).toHaveAttribute("aria-pressed", "true");
  const anteriorCamera = fieldRecord(await anatomyContext(page), "camera");
  expect(anteriorCamera.view).toBe("anterior");
  expect(anteriorCamera.position).not.toEqual(leftCamera.position);

  await executeTool(page, "anatomy_navigate", { action: "set_view", section: "pelvis" });
  const modeResult = await executeTool(page, "anatomy_navigate", { action: "set_view", mode: "test" });
  await expect(root).toHaveAttribute("data-anatomy-mode", "test");
  const testInputs = root.getByRole("textbox", { name: /Answer for question/ });
  await expect(testInputs).toHaveCount(2);
  const rejectedIdentity = await page.evaluate(() =>
    window.__anatomyAcceptance.invoke("anatomy_navigate", { action: "focus", boneId: "left-hip-bone" }),
  );
  expect(isRecord(rejectedIdentity) ? rejectedIdentity.outcome : null).toBe("error");
  const hiddenContext = await anatomyContext(page);
  const hiddenDescriptors = (await page.evaluate(() => window.__anatomyAcceptance.descriptors()))
    .filter((descriptor) => descriptor.name.startsWith("anatomy_"));
  const allToolNames = await page.evaluate(() => window.__anatomyAcceptance.names());
  const hiddenEvidence = await page.evaluate(() => ({
    text: document.body.innerText,
    dom: document.documentElement.outerHTML,
  }));
  expect(secretMatches(modeResult), "Mode change output must not disclose a pelvis identity.").toEqual([]);
  expect(secretMatches(rejectedIdentity), "Rejected identity lookup must fail without echoing the secret.").toEqual([]);
  expect(secretMatches(hiddenContext), "Test-mode context must use opaque question numbers.").toEqual([]);
  expect(secretMatches(hiddenDescriptors), "Registered Test-mode descriptors must not disclose hidden identities.").toEqual([]);
  expect(allToolNames, "The app-owned manual score command must never be exposed through WebMCP.")
    .not.toContain("page_anatomy_quiz_submit");
  expect(secretMatches(hiddenEvidence.text), "Visible pre-submit test copy must hide all answers.").toEqual([]);
  expect(secretMatches(hiddenEvidence.dom), "Pre-submit DOM must not contain hidden IDs, labels, aliases, or source object names.").toEqual([]);

  const answers = PELVIS.map((bone, index) => ({ questionNumber: index + 1, answer: bone.name }));
  const answerResults = [];
  for (const answer of answers) {
    answerResults.push(await executeTool(page, "anatomy_test", { action: "answer", ...answer }));
  }
  expect(secretMatches(answerResults), "Answer acknowledgements must not echo hidden answers.").toEqual([]);
  const score = await executeTool(page, "anatomy_test", { action: "submit" });
  const scoreRecord = fieldRecord(score, "score");
  expect(requiredNumber(scoreRecord, "correct")).toBe(2);
  expect(requiredNumber(scoreRecord, "total")).toBe(2);
  await expect(root).toContainText("2/2");
  const scoredScreenshot = testInfo.outputPath("atlas-scored.png");
  await page.screenshot({ path: scoredScreenshot, fullPage: true, animations: "disabled" });

  await root.getByRole("button", { name: "Try again" }).click();
  await expect(root.getByRole("button", { name: "Submit score" })).toBeVisible();
  expect(await testInputs.evaluateAll((inputs) => inputs.map((input) => input instanceof HTMLInputElement ? input.value : null)))
    .toEqual(["", ""]);
  await testInputs.nth(0).fill(PELVIS[0]?.name ?? "");
  await executeTool(page, "anatomy_test", { action: "answer", questionNumber: 2, answer: PELVIS[1]?.name ?? "" });
  await root.getByRole("button", { name: "Submit score" }).click();
  await expect(root.locator(".anatomy-score-pill")).toContainText("2/2");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForAtlasReady(page);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);
  await expect(page.locator(".anatomy-score-pill")).toContainText("2/2");
  const reloadRegistrations = await page.evaluate(() => window.__anatomyAcceptance.registrationCounts());
  expect(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, reloadRegistrations[name]])))
    .toEqual(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, 1])));
  const persistedPage = requiredRecord(await executeTool(page, "page_context_read", {}), "context");
  expect(requiredNumber(persistedPage, "pageCount")).toBe(7);

  await page.getByRole("button", { name: "Next" }).click();
  const coloringRoot = page.locator('.anatomy-coloring-card[data-atlas-state="ready"]');
  await expect(coloringRoot, "Page 2 must mount the first source-mesh coloring lab.").toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".anatomy-model-canvas canvas"), "Exactly one live WebGL canvas is allowed.").toHaveCount(1);
  const coloringCanvas = coloringRoot.locator(".anatomy-model-canvas canvas");
  await expect(coloringCanvas).toHaveAttribute("data-visible-section", "skull");
  await expect(coloringCanvas).toHaveAttribute("data-visible-semantic-meshes", "29");

  await coloringRoot.getByRole("button", { name: "Label yourself" }).click();
  const firstRecall = coloringRoot.getByRole("textbox", { name: "Coloring answer for question 1", exact: true });
  await expect(firstRecall).toBeFocused();
  await firstRecall.pressSequentially("Frontal bone", { delay: 8 });
  await firstRecall.press("Enter");
  await expect(coloringRoot.getByRole("textbox", { name: "Coloring answer for question 2", exact: true })).toBeFocused();
  await coloringRoot.getByRole("button", { name: "Labels on" }).click();
  await coloringRoot.getByRole("button", { name: "Back to section" }).click();
  await page.waitForTimeout(500);

  const skullGeometry = await measureRenderedSkeleton(page, coloringCanvas, testInfo.outputPath("coloring-skull-fit.png"));
  expect(skullGeometry.bounds, "The fitted skull must render visible geometry.").not.toBeNull();
  expect(skullGeometry.samplePoints.length, "The fitted skull must expose real surface pixels for a pointer stroke.")
    .toBeGreaterThan(5);
  const coloringBox = await coloringCanvas.boundingBox();
  if (coloringBox === null || skullGeometry.bounds === null) throw new Error("The fitted skull canvas was not measurable.");
  expect(skullGeometry.bounds.x).toBeGreaterThan(8);
  expect(skullGeometry.bounds.y).toBeGreaterThan(8);
  expect(skullGeometry.bounds.x + skullGeometry.bounds.width).toBeLessThan(skullGeometry.imageWidth - 8);
  expect(skullGeometry.bounds.y + skullGeometry.bounds.height).toBeLessThan(skullGeometry.imageHeight - 8);
  expect(skullGeometry.bounds.width).toBeGreaterThan(skullGeometry.imageWidth * 0.18);
  expect(skullGeometry.bounds.height).toBeGreaterThan(skullGeometry.imageHeight * 0.18);

  const selectionPoint = skullGeometry.samplePoints[0];
  if (selectionPoint === undefined) throw new Error("The fitted skull had no selectable surface pixel.");
  await page.mouse.click(
    coloringBox.x + selectionPoint.x / skullGeometry.imageWidth * coloringBox.width,
    coloringBox.y + selectionPoint.y / skullGeometry.imageHeight * coloringBox.height,
  );
  await expect.poll(() => coloringRoot.getAttribute("data-workspace-bone"), {
    message: "Clicking a rendered bone must open its isolated paint workspace.",
  }).not.toBe("section");
  const workspaceBoneId = await coloringRoot.getAttribute("data-workspace-bone");
  const workspaceBone = ADULT_SKELETON_BONES.find((bone) => bone.id === workspaceBoneId);
  if (workspaceBone === undefined) throw new Error(`The bone workspace exposed an unknown id: ${workspaceBoneId}.`);
  await expect(coloringCanvas).toHaveAttribute("data-visible-semantic-meshes", String(workspaceBone.sourceMeshCount));
  await expect(coloringRoot.getByLabel(`Bone workspace for ${workspaceBone.name}`)).toBeVisible();
  await expect(coloringRoot.getByRole("button", { name: "Paint" })).toHaveAttribute("aria-pressed", "true");
  await expect(coloringCanvas).toHaveAttribute("data-atlas-exact-composition-state", "settled", { timeout: 5_000 });

  const isolatedGeometry = await measureRenderedSkeleton(
    page,
    coloringCanvas,
    testInfo.outputPath(`coloring-isolated-${workspaceBone.id}.png`),
  );
  expect(isolatedGeometry.bounds, "The isolated bone must have measurable working bounds.").not.toBeNull();
  if (isolatedGeometry.bounds === null) throw new Error("The isolated bone had no measurable working bounds.");
  const isolatedWorkingScale = Math.max(
    isolatedGeometry.bounds.width / isolatedGeometry.imageWidth,
    isolatedGeometry.bounds.height / isolatedGeometry.imageHeight,
  );
  expect(isolatedWorkingScale, "The isolated bone must fill enough of the canvas for deliberate brush work.")
    .toBeGreaterThan(0.45);
  expect(isolatedGeometry.samplePoints.length, "The isolated bone must expose real pixels for brush input.")
    .toBeGreaterThan(5);
  await coloringRoot.getByRole("button", { name: "Sweep" }).click();
  const strokePoints = isolatedGeometry.samplePoints.slice(0, 12).map((point) => ({
    x: coloringBox.x + point.x / isolatedGeometry.imageWidth * coloringBox.width,
    y: coloringBox.y + point.y / isolatedGeometry.imageHeight * coloringBox.height,
  }));
  const firstStrokePoint = strokePoints[0];
  if (firstStrokePoint === undefined) throw new Error("The isolated bone had no paintable pixel.");
  await page.mouse.move(firstStrokePoint.x, firstStrokePoint.y);
  await page.mouse.down();
  for (const point of strokePoints.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
  await page.mouse.up();
  await expect(coloringRoot).toHaveAttribute("data-paint-state", "idle", { timeout: 5_000 });
  await expect(coloringRoot, "One pointer gesture must produce one local surface stroke.")
    .toHaveAttribute("data-surface-strokes", "1");
  await expect.poll(async () => Number.parseInt(await coloringRoot.getAttribute("data-surface-anchors") ?? "0", 10), {
    message: "The local surface stroke must contain anchored samples from the source mesh.",
  }).toBeGreaterThan(0);
  await expect.poll(async () => requiredNumber(await executeTool(page, "page_anatomy_coloring_read", {}), "surfaceStrokeCount"), {
    message: "The isolated surface stroke must persist through the app-owned command path.",
  }).toBe(1);
  const paintedColoring = await executeTool(page, "page_anatomy_coloring_read", {});
  const surfaceStrokeCount = requiredNumber(paintedColoring, "surfaceStrokeCount");
  const surfaceAnchorCount = requiredNumber(paintedColoring, "surfaceAnchorCount");
  const surfaceStateFingerprint = requiredString(paintedColoring, "surfaceStateFingerprint");
  expect(surfaceStrokeCount).toBe(1);
  expect(surfaceAnchorCount).toBeGreaterThan(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForTools(page, ["page_context_read", "page_anatomy_coloring_read"]);
  const reloadPageContext = requiredRecord(await executeTool(page, "page_context_read", {}), "context");
  if (requiredNumber(reloadPageContext, "focusedPageNumber") === 1) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  const reloadedColoring = page.locator('.anatomy-coloring-card[data-atlas-state="ready"]');
  await expect(reloadedColoring).toBeVisible({ timeout: 30_000 });
  await expect(reloadedColoring).toHaveAttribute("data-surface-strokes", String(surfaceStrokeCount));
  await expect(reloadedColoring).toHaveAttribute("data-surface-anchors", String(surfaceAnchorCount));
  const reloadedPaint = await executeTool(page, "page_anatomy_coloring_read", {});
  expect(requiredString(reloadedPaint, "surfaceStateFingerprint")).toBe(surfaceStateFingerprint);
  await reloadedColoring.getByRole("button", { name: "Clear section", exact: true }).click();
  await expect(reloadedColoring).toHaveAttribute("data-paint-state", "idle", { timeout: 5_000 });
  await expect(reloadedColoring).toHaveAttribute("data-surface-strokes", "0");
  await expect(reloadedColoring).toHaveAttribute("data-surface-anchors", "0");
  await expect.poll(async () => requiredNumber(await executeTool(page, "page_anatomy_coloring_read", {}), "surfaceStrokeCount"))
    .toBe(0);

  const fittedSections = [{ section: "skull", meshes: 29, page: 2 }];
  const remainingSections = [
    { section: "vertebral-column", meshes: 26, page: 3 },
    { section: "thorax", meshes: 27, page: 4 },
    { section: "upper-limb", meshes: 64, page: 5 },
    { section: "pelvis", meshes: 2, page: 6 },
    { section: "lower-limb", meshes: 60, page: 7 },
  ] as const;
  for (const expectedSection of remainingSections) {
    await page.getByRole("button", { name: "Next" }).click();
    const sectionRoot = page.locator(`.anatomy-coloring-card[data-section="${expectedSection.section}"][data-atlas-state="ready"]`);
    await expect(sectionRoot).toBeVisible({ timeout: 30_000 });
    const sectionCanvas = sectionRoot.locator(".anatomy-model-canvas canvas");
    await expect(sectionCanvas).toHaveAttribute("data-visible-section", expectedSection.section);
    await expect(sectionCanvas).toHaveAttribute("data-visible-semantic-meshes", String(expectedSection.meshes));
    await expect(page.locator(".anatomy-model-canvas canvas")).toHaveCount(1);
    const fit = await measureRenderedSkeleton(page, sectionCanvas, testInfo.outputPath(`coloring-fit-${expectedSection.section}.png`));
    expect(fit.bounds, `${expectedSection.section} must render after its automatic section fit.`).not.toBeNull();
    if (fit.bounds === null) throw new Error(`${expectedSection.section} had no rendered bounds.`);
    expect(fit.bounds.x).toBeGreaterThan(8);
    expect(fit.bounds.y).toBeGreaterThan(8);
    expect(fit.bounds.x + fit.bounds.width).toBeLessThan(fit.imageWidth - 8);
    expect(fit.bounds.y + fit.bounds.height).toBeLessThan(fit.imageHeight - 8);
    fittedSections.push(expectedSection);
  }

  for (let pageNumber = 7; pageNumber > 1; pageNumber -= 1) {
    await page.getByRole("button", { name: "Previous" }).click();
  }
  await waitForAtlasReady(page);

  const drawBeforeShelf = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  await page.getByRole("button", { name: /Shelf/ }).click();
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
  await expect(page.locator(".anatomy-model-canvas canvas")).toHaveCount(0);
  await page.waitForTimeout(1_250);
  const drawAfterShelf = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  expect(drawAfterShelf.clears, "Unmounted atlas code must not keep rendering on the shelf.").toBe(drawBeforeShelf.clears);
  const staleCall = await page.evaluate(() => window.__anatomyAcceptance.invoke("anatomy_context_read", {}));
  expect(isRecord(staleCall) ? staleCall.outcome : null, "Unmounted anatomy tools must fail closed.").toBe("error");

  await page.getByRole("button", { name: `Open ${title} notebook` }).click();
  await waitForAtlasReady(page);
  await expect(page.locator(".anatomy-model-canvas canvas")).toHaveCount(1);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);
  const remountRegistrations = await page.evaluate(() => window.__anatomyAcceptance.registrationCounts());
  expect(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, remountRegistrations[name]])),
    "A shelf return must reactivate the existing callbacks without duplicate registrations.")
    .toEqual(Object.fromEntries(EXPECTED_ANATOMY_TOOLS.map((name) => [name, 1])));
  expect(requiredNumber(await anatomyContext(page), "logicalBoneCount")).toBe(EXPECTED_LOGICAL_BONES);
  expectNoBrowserErrors(issues);
  await writeEvidence(testInfo, "functional-evidence.json", {
    notebook,
    anatomyToolNames,
    integrity,
    servedAtlas,
    initialBone,
    semanticInventory,
    visibleCatalogLabels,
    pointerRaycasts: { isolatedBySection: sectionRaycasts, unisolatedLeftPatella: raycastPoint },
    camera: { beforeDrag: cameraBeforeDrag, afterDrag: cameraAfterDrag },
    secrecy: { secretsChecked: PELVIS_SECRETS, hiddenContext },
    score: scoreRecord,
    persistence: { url: page.url(), pageCount: 7 },
    coloring: {
      surfaceStrokeCount,
      surfaceAnchorCount,
      surfaceStateFingerprint,
      workspaceBoneId,
      workspaceSourceMeshes: workspaceBone.sourceMeshCount,
      fittedSections,
      oneLiveCanvas: true,
      recallEnterAdvanced: true,
    },
    remount: { drawBeforeShelf, drawAfterShelf, canvasCount: 1 },
  });
});

test("@mobile keeps the atlas and opaque test controls usable at 390 by 844", async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe("anatomy-mobile");
  const issues = observeBrowser(page);
  await createAtlasNotebook(page, "Anatomy mobile acceptance");
  await waitForAtlasReady(page);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);
  await executeTool(page, "anatomy_navigate", { action: "set_view", section: "pelvis" });
  await executeTool(page, "anatomy_navigate", { action: "set_view", mode: "test" });

  const root = page.locator('.anatomy-study-card[data-atlas-state="ready"]');
  await root.scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => {
    const bounds = (selector: string): DOMRect | null => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      root: bounds(".anatomy-study-card"),
      stage: bounds(".anatomy-model-stage"),
      canvas: bounds(".anatomy-model-canvas canvas"),
    };
  });
  expect(geometry.documentWidth, "The notebook must not create page-level horizontal overflow.")
    .toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.root).not.toBeNull();
  expect(geometry.stage).not.toBeNull();
  expect(geometry.canvas).not.toBeNull();
  if (geometry.stage === null || geometry.canvas === null) throw new Error("The responsive stage was not measurable.");
  expect(geometry.canvas.x).toBeGreaterThanOrEqual(geometry.stage.x - 1);
  expect(geometry.canvas.x + geometry.canvas.width).toBeLessThanOrEqual(geometry.stage.x + geometry.stage.width + 1);
  expect(geometry.canvas.width, "The mobile atlas needs a useful visible canvas.").toBeGreaterThanOrEqual(300);
  expect(geometry.canvas.height, "The mobile atlas needs a useful visible canvas.").toBeGreaterThanOrEqual(260);

  await expectMinimumTarget(root.getByRole("button", { name: "Study" }), 44, "Study mode");
  await expectMinimumTarget(root.getByRole("button", { name: "Test" }), 44, "Test mode");
  await expectMinimumTarget(root.getByRole("button", { name: "Submit score" }), 44, "Submit score");
  const firstInput = root.getByRole("textbox", { name: "Answer for question 1" });
  await firstInput.scrollIntoViewIfNeeded();
  await expect(firstInput).toBeVisible();
  const inputBox = await firstInput.boundingBox();
  if (inputBox === null) throw new Error("The first mobile test input was not measurable.");
  expect(inputBox.height).toBeGreaterThanOrEqual(44);
  expect(secretMatches(await anatomyContext(page))).toEqual([]);
  const screenshotPath = testInfo.outputPath("atlas-mobile-test.png");
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
  expectNoBrowserErrors(issues);
  await writeEvidence(testInfo, "mobile-evidence.json", { geometry, inputBox, viewport: page.viewportSize() });
});

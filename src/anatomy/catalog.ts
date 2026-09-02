export type AnatomySection =
  | "skull"
  | "vertebral-column"
  | "thorax"
  | "upper-limb"
  | "pelvis"
  | "lower-limb";

export type BoneSide = "midline" | "left" | "right";

export type BoneEntry = Readonly<{
  id: string;
  name: string;
  acceptedAnswers: readonly string[];
  section: AnatomySection;
  side: BoneSide;
  sourceObjects: readonly [string, ...string[]];
  sourceMeshCount: 1 | 3;
}>;

export const ANATOMY_CATALOG_VERSION = "adult-skeleton-206-v2-z-anatomy";
export const VERIFIED_ATLAS_VERSION = "z-anatomy-source-mesh-206-v1";
export const VERIFIED_ATLAS_LOGICAL_BONE_COUNT = 206;
export const VERIFIED_ATLAS_SEMANTIC_MESH_COUNT = 208;

export const ANATOMY_SECTIONS: readonly Readonly<{
  id: AnatomySection;
  label: string;
  shortLabel: string;
}>[] = [
  { id: "skull", label: "Skull, ossicles, and hyoid", shortLabel: "Head" },
  { id: "vertebral-column", label: "Vertebral column", shortLabel: "Spine" },
  { id: "thorax", label: "Thoracic cage", shortLabel: "Thorax" },
  { id: "upper-limb", label: "Pectoral girdle and upper limbs", shortLabel: "Upper limbs" },
  { id: "pelvis", label: "Pelvic girdle", shortLabel: "Pelvis" },
  { id: "lower-limb", label: "Lower limbs", shortLabel: "Lower limbs" },
];

const ROMAN = ["I", "II", "III", "IV", "V"] as const;
const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth"] as const;
const RIB_ORDINAL = [
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
  "Eleventh",
  "Twelfth",
] as const;
const SIDE_DATA: readonly Readonly<{
  side: "left" | "right";
  label: "Left" | "Right";
  sourceSuffix: ".l" | ".r";
}>[] = [
  { side: "left", label: "Left", sourceSuffix: ".l" },
  { side: "right", label: "Right", sourceSuffix: ".r" },
];

function slug(value: string): string {
  return value.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "");
}

function capitalize(value: string): string {
  const first = value[0];
  if (first === undefined) throw new Error("An anatomy source-object name cannot be empty.");
  return `${first.toLocaleUpperCase()}${value.slice(1)}`;
}

function ordinalAt(index: number): typeof ORDINAL[number] {
  const ordinal = ORDINAL[index];
  if (ordinal === undefined) throw new Error(`No anatomy ordinal is registered at index ${index}.`);
  return ordinal;
}

function ribOrdinalAt(index: number): typeof RIB_ORDINAL[number] {
  const ordinal = RIB_ORDINAL[index];
  if (ordinal === undefined) throw new Error(`No rib ordinal is registered at index ${index}.`);
  return ordinal;
}

function entry(input: Omit<BoneEntry, "id" | "acceptedAnswers" | "sourceMeshCount"> & Readonly<{
  id?: string;
  acceptedAnswers?: readonly string[];
  sourceMeshCount?: 1 | 3;
}>): BoneEntry {
  return {
    id: input.id ?? slug(input.name),
    name: input.name,
    acceptedAnswers: input.acceptedAnswers ?? [input.name],
    section: input.section,
    side: input.side,
    sourceObjects: input.sourceObjects,
    sourceMeshCount: input.sourceMeshCount ?? 1,
  };
}

function paired(input: Readonly<{
  name: string;
  sourceName: string;
  section: AnatomySection;
  aliases?: readonly string[];
}>): BoneEntry[] {
  return SIDE_DATA.map(({ side, label, sourceSuffix }) => entry({
    name: `${label} ${input.name}`,
    acceptedAnswers: [input.name, `${label} ${input.name}`, ...(input.aliases ?? [])],
    section: input.section,
    side,
    sourceObjects: [`${input.sourceName}${sourceSuffix}`],
  }));
}

const cranialBones: BoneEntry[] = [
  entry({ name: "Frontal bone", section: "skull", side: "midline", sourceObjects: ["Frontal bone"] }),
  ...paired({ name: "parietal bone", sourceName: "Parietal bone", section: "skull" }),
  ...paired({ name: "temporal bone", sourceName: "Temporal bone", section: "skull" }),
  entry({ name: "Occipital bone", section: "skull", side: "midline", sourceObjects: ["Occipital bone"] }),
  entry({ name: "Sphenoid bone", section: "skull", side: "midline", sourceObjects: ["Sphenoid bone"] }),
  entry({ name: "Ethmoid bone", section: "skull", side: "midline", sourceObjects: ["Ethmoid bone"] }),
];

const facialBones: BoneEntry[] = [
  entry({ name: "Mandible", section: "skull", side: "midline", sourceObjects: ["Mandible"] }),
  ...paired({ name: "maxilla", sourceName: "Maxilla", section: "skull", aliases: ["maxillary bone"] }),
  ...paired({ name: "palatine bone", sourceName: "Palatine bone", section: "skull" }),
  ...paired({ name: "zygomatic bone", sourceName: "Zygomatic bone", section: "skull", aliases: ["cheekbone"] }),
  ...paired({ name: "nasal bone", sourceName: "Nasal bone", section: "skull" }),
  ...paired({ name: "lacrimal bone", sourceName: "Lacrimal bone", section: "skull" }),
  ...paired({ name: "inferior nasal concha", sourceName: "Inferior nasal concha bone", section: "skull" }),
  entry({ name: "Vomer", section: "skull", side: "midline", sourceObjects: ["Vomer"] }),
];

const ossiclesAndHyoid: BoneEntry[] = [
  ...paired({ name: "malleus", sourceName: "Malleus", section: "skull" }),
  ...paired({ name: "incus", sourceName: "Incus", section: "skull" }),
  ...paired({ name: "stapes", sourceName: "Stapes", section: "skull" }),
  entry({ name: "Hyoid bone", section: "skull", side: "midline", sourceObjects: ["Hyoid bone"] }),
];

const cervicalVertebrae = Array.from({ length: 7 }, (_, index) => entry({
  name: index === 0 ? "Atlas (C1)" : index === 1 ? "Axis (C2)" : `Cervical vertebra C${index + 1}`,
  acceptedAnswers: index === 0 ? ["Atlas", "C1", "Atlas (C1)"] : index === 1 ? ["Axis", "C2", "Axis (C2)"] : [`C${index + 1}`, `Cervical vertebra C${index + 1}`],
  section: "vertebral-column",
  side: "midline",
  sourceObjects: [index === 0 ? "Atlas (C1)" : index === 1 ? "Axis (C2)" : `Vertebra C${index + 1}`],
}));

const thoracicVertebrae = Array.from({ length: 12 }, (_, index) => entry({
  name: `Thoracic vertebra T${index + 1}`,
  acceptedAnswers: [`T${index + 1}`, `Thoracic vertebra T${index + 1}`],
  section: "vertebral-column",
  side: "midline",
  sourceObjects: [`Vertebra T${index + 1}`],
}));

const lumbarVertebrae = Array.from({ length: 5 }, (_, index) => entry({
  name: `Lumbar vertebra L${index + 1}`,
  acceptedAnswers: [`L${index + 1}`, `Lumbar vertebra L${index + 1}`],
  section: "vertebral-column",
  side: "midline",
  sourceObjects: [`Vertebra L${index + 1}`],
}));

const vertebralColumn: BoneEntry[] = [
  ...cervicalVertebrae,
  ...thoracicVertebrae,
  ...lumbarVertebrae,
  entry({ name: "Sacrum", section: "vertebral-column", side: "midline", sourceObjects: ["Sacrum"] }),
  entry({ name: "Coccyx", section: "vertebral-column", side: "midline", sourceObjects: ["Coccyx"] }),
];

const ribs = SIDE_DATA.flatMap(({ side, label, sourceSuffix }) => Array.from({ length: 12 }, (_, index) => {
  const ribNumber = index + 1;
  return entry({
    name: `${label} rib ${ribNumber}`,
    acceptedAnswers: [`Rib ${ribNumber}`, `${label} rib ${ribNumber}`],
    section: "thorax",
    side,
    sourceObjects: [`${ribOrdinalAt(index)} rib${sourceSuffix}`],
  });
}));

const thorax: BoneEntry[] = [
  entry({
    name: "Sternum",
    section: "thorax",
    side: "midline",
    sourceObjects: ["Body of sternum", "Manubrium of sternum", "Xiphoid process"],
    sourceMeshCount: 3,
  }),
  ...ribs,
];

function handBones(side: "left" | "right", label: "Left" | "Right", sourceSuffix: ".l" | ".r"): BoneEntry[] {
  const carpalNames = ["scaphoid", "lunate", "triquetrum", "pisiform", "trapezium", "trapezoid", "capitate", "hamate"];
  const carpals = carpalNames.map((name) => entry({
    name: `${label} ${name}`,
    acceptedAnswers: [name, `${label} ${name}`],
    section: "upper-limb",
    side,
    sourceObjects: [`${capitalize(name)} bone${sourceSuffix}`],
  }));
  const metacarpals = ROMAN.map((number, index) => entry({
    name: `${label} metacarpal ${number}`,
    acceptedAnswers: [`Metacarpal ${number}`, `${label} metacarpal ${number}`],
    section: "upper-limb",
    side,
    sourceObjects: [`${ordinalAt(index)} metacarpal bone${sourceSuffix}`],
  }));
  const phalanges = ROMAN.flatMap((number, digitIndex) => {
    const levels = digitIndex === 0 ? ["proximal", "distal"] : ["proximal", "middle", "distal"];
    return levels.map((level) => entry({
      name: `${label} hand digit ${number} ${level} phalanx`,
      acceptedAnswers: [`${level} phalanx`, `Digit ${number} ${level} phalanx`, `${label} hand digit ${number} ${level} phalanx`],
      section: "upper-limb",
      side,
      sourceObjects: [`${capitalize(level)} phalanx of ${ordinalAt(digitIndex).toLocaleLowerCase()} finger of hand${sourceSuffix}`],
    }));
  });
  return [...carpals, ...metacarpals, ...phalanges];
}

const upperLimbs = SIDE_DATA.flatMap(({ side, label, sourceSuffix }) => [
  entry({ name: `${label} clavicle`, acceptedAnswers: ["Clavicle", `${label} clavicle`], section: "upper-limb", side, sourceObjects: [`Clavicle${sourceSuffix}`] }),
  entry({ name: `${label} scapula`, acceptedAnswers: ["Scapula", `${label} scapula`], section: "upper-limb", side, sourceObjects: [`Scapula${sourceSuffix}`] }),
  entry({ name: `${label} humerus`, acceptedAnswers: ["Humerus", `${label} humerus`], section: "upper-limb", side, sourceObjects: [`Humerus${sourceSuffix}`] }),
  entry({ name: `${label} radius`, acceptedAnswers: ["Radius", `${label} radius`], section: "upper-limb", side, sourceObjects: [`Radius${sourceSuffix}`] }),
  entry({ name: `${label} ulna`, acceptedAnswers: ["Ulna", `${label} ulna`], section: "upper-limb", side, sourceObjects: [`Ulna${sourceSuffix}`] }),
  ...handBones(side, label, sourceSuffix),
]);

const pelvis = SIDE_DATA.map(({ side, label, sourceSuffix }) => entry({
  name: `${label} hip bone`,
  acceptedAnswers: ["Hip bone", "Coxal bone", "Os coxae", `${label} hip bone`],
  section: "pelvis",
  side,
  sourceObjects: [`Hip bone${sourceSuffix}`],
}));

function footBones(side: "left" | "right", label: "Left" | "Right", sourceSuffix: ".l" | ".r"): BoneEntry[] {
  const tarsalNames = [
    { name: "talus", sourceName: "Talus" },
    { name: "calcaneus", sourceName: "Calcaneus" },
    { name: "navicular", sourceName: "Navicular bone" },
    { name: "cuboid", sourceName: "Cuboid bone" },
    { name: "medial cuneiform", sourceName: "Medial cuneiform bone" },
    { name: "intermediate cuneiform", sourceName: "Intermediate cuneiform bone" },
    { name: "lateral cuneiform", sourceName: "Lateral cuneiform bone" },
  ] as const;
  const tarsals = tarsalNames.map(({ name, sourceName }) => entry({
    name: `${label} ${name}`,
    acceptedAnswers: [name, `${label} ${name}`],
    section: "lower-limb",
    side,
    sourceObjects: [`${sourceName}${sourceSuffix}`],
  }));
  const metatarsals = ROMAN.map((number, index) => entry({
    name: `${label} metatarsal ${number}`,
    acceptedAnswers: [`Metatarsal ${number}`, `${label} metatarsal ${number}`],
    section: "lower-limb",
    side,
    sourceObjects: [`${ordinalAt(index)} metatarsal bone${sourceSuffix}`],
  }));
  const phalanges = ROMAN.flatMap((number, digitIndex) => {
    const levels = digitIndex === 0 ? ["proximal", "distal"] : ["proximal", "middle", "distal"];
    return levels.map((level) => entry({
      name: `${label} foot digit ${number} ${level} phalanx`,
      acceptedAnswers: [`${level} phalanx`, `Digit ${number} ${level} phalanx`, `${label} foot digit ${number} ${level} phalanx`],
      section: "lower-limb",
      side,
      sourceObjects: [`${capitalize(level)} phalanx of ${ordinalAt(digitIndex).toLocaleLowerCase()} finger of foot${sourceSuffix}`],
    }));
  });
  return [...tarsals, ...metatarsals, ...phalanges];
}

const lowerLimbs = SIDE_DATA.flatMap(({ side, label, sourceSuffix }) => [
  entry({ name: `${label} femur`, acceptedAnswers: ["Femur", `${label} femur`], section: "lower-limb", side, sourceObjects: [`Femur${sourceSuffix}`] }),
  entry({ name: `${label} patella`, acceptedAnswers: ["Patella", `${label} patella`], section: "lower-limb", side, sourceObjects: [`Patella${sourceSuffix}`] }),
  entry({ name: `${label} tibia`, acceptedAnswers: ["Tibia", `${label} tibia`], section: "lower-limb", side, sourceObjects: [`Tibia${sourceSuffix}`] }),
  entry({ name: `${label} fibula`, acceptedAnswers: ["Fibula", `${label} fibula`], section: "lower-limb", side, sourceObjects: [`Fibula${sourceSuffix}`] }),
  ...footBones(side, label, sourceSuffix),
]);

export const ADULT_SKELETON_BONES: readonly BoneEntry[] = [
  ...cranialBones,
  ...facialBones,
  ...ossiclesAndHyoid,
  ...vertebralColumn,
  ...thorax,
  ...upperLimbs,
  ...pelvis,
  ...lowerLimbs,
];

export function bonesForSection(section: AnatomySection): readonly BoneEntry[] {
  return ADULT_SKELETON_BONES.filter((bone) => bone.section === section);
}

function normalizedAnswer(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

export function isCorrectBoneAnswer(bone: BoneEntry, answer: string): boolean {
  const normalized = normalizedAnswer(answer);
  return bone.acceptedAnswers.some((candidate) => normalizedAnswer(candidate) === normalized);
}

export function scoreBoneAnswers(answers: Readonly<Record<string, string>>, bones: readonly BoneEntry[]): Readonly<{
  correct: number;
  total: number;
  unanswered: number;
}> {
  let correct = 0;
  let unanswered = 0;
  for (const bone of bones) {
    const answer = answers[bone.id] ?? "";
    if (answer.trim().length === 0) unanswered += 1;
    else if (isCorrectBoneAnswer(bone, answer)) correct += 1;
  }
  return { correct, total: bones.length, unanswered };
}

const logicalBoneIds = new Set(ADULT_SKELETON_BONES.map((bone) => bone.id));
const sourceObjectNames = ADULT_SKELETON_BONES.flatMap((bone) => [...bone.sourceObjects]);
const declaredSemanticMeshCount = ADULT_SKELETON_BONES.reduce((total, bone) => total + bone.sourceMeshCount, 0);

if (ADULT_SKELETON_BONES.length !== VERIFIED_ATLAS_LOGICAL_BONE_COUNT || logicalBoneIds.size !== VERIFIED_ATLAS_LOGICAL_BONE_COUNT) {
  throw new Error(`The adult skeleton catalogue must contain ${VERIFIED_ATLAS_LOGICAL_BONE_COUNT} unique bones; found ${logicalBoneIds.size}.`);
}
if (sourceObjectNames.length !== VERIFIED_ATLAS_SEMANTIC_MESH_COUNT ||
  declaredSemanticMeshCount !== VERIFIED_ATLAS_SEMANTIC_MESH_COUNT ||
  new Set(sourceObjectNames).size !== VERIFIED_ATLAS_SEMANTIC_MESH_COUNT) {
  throw new Error(`The verified atlas contract must contain ${VERIFIED_ATLAS_SEMANTIC_MESH_COUNT} unique semantic source meshes.`);
}
if (ADULT_SKELETON_BONES.some((bone) => bone.sourceObjects.length !== bone.sourceMeshCount)) {
  throw new Error("Each anatomy bone must declare the exact number of source meshes it owns.");
}

import { applyAnatomyComposition, createAnatomyCompositionProposal } from "../anatomy";
import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
  createRevision,
  type JsonValue,
  type Notebook,
  type NotebookId,
  type Revision,
} from "../domain";
import { notebookToRow, parseNotebookRow } from "../indexeddb/database";
import {
  CALCULUS_PRACTICE_COMPONENT,
  COLORING_BOOK_COMPONENT,
  LEARNING_ACTIVITY_VERSION,
} from "../learning/activities";
import {
  appendPage,
  createEmptyPageDocument,
  richTextFromPlainText,
  stableBlockId,
  stableElementId,
  validatePageDocument,
  type PageDocument,
  type EmbeddedFrameElement,
  type TextElement,
} from "../page";
import { createWorkspaceController, type WorkspaceController } from "../workspace/controller";
import { createBrowserWorkspaceHistory } from "../workspace/history";
import type { WorkspaceOperationResult } from "../workspace/model";
import type { WorkspaceBootstrap, WorkspaceMetadata, WorkspacePersistence } from "../workspace/persistence";
import { SessionPageStorage } from "./session-page-storage";

export const DEMO_WORKSPACE_LIMITS = {
  seededNotebooks: 4,
  visitorNotebooks: 1,
  totalNotebooks: 5,
} as const;

const SEED_TIME = createIsoInstant("2026-09-01T12:00:00.000Z");
const INBOX_ID = createNotebookId("demo-inbox");
export const INSTRUCTION_NOTEBOOK_ID = createNotebookId("instruction-notebook");
export const ANATOMY_NOTEBOOK_ID = createNotebookId("anatomy-exam-prep");
export const CALCULUS_NOTEBOOK_ID = createNotebookId("calculus-1-test-prep");
export const COLORING_NOTEBOOK_ID = createNotebookId("field-notes-coloring-book");
const NOTEBOOK_SESSION_KEY = "project-notebook-demo:notebooks:v5";

type SessionCache = Pick<Storage, "getItem" | "setItem">;

function browserSessionCache(): SessionCache | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function seedNotebook(id: NotebookId, title: string, subject: string, offsetMinutes: number): Notebook {
  return createNotebook({
    id,
    title,
    subject,
    createdAt: createIsoInstant(`2026-09-01T12:${String(offsetMinutes).padStart(2, "0")}:00.000Z`),
  });
}

function textElement(input: Readonly<{
  key: string;
  label: string;
  text: string;
  kind?: "heading" | "paragraph" | "quote";
  followingText?: string;
  y: number;
  height: number;
}>): TextElement {
  const content = richTextFromPlainText(input.text, stableBlockId(input.key), input.kind ?? "paragraph");
  const supportedContent = input.kind === "heading"
    ? {
        ...content,
        blocks: [
          ...content.blocks,
          {
            id: stableBlockId(`${input.key}:following`),
            kind: "paragraph" as const,
            runs: [{ text: input.followingText ?? "Use the bounded controls below.", marks: [] }],
          },
        ],
      }
    : content;
  return {
    kind: "text",
    id: stableElementId("demo-instruction", input.key),
    label: input.label,
    frame: { x: 96, y: input.y, width: 624, height: input.height },
    content: supportedContent,
  };
}

function activityElement(input: Readonly<{
  key: string;
  label: string;
  componentType: typeof CALCULUS_PRACTICE_COMPONENT | typeof COLORING_BOOK_COMPONENT;
  props: JsonValue;
  frame?: EmbeddedFrameElement["frame"];
}>): EmbeddedFrameElement {
  return {
    kind: "embedded-frame",
    id: stableElementId("demo-activity", input.key),
    label: input.label,
    frame: input.frame ?? { x: 72, y: 244, width: 672, height: 736 },
    componentType: input.componentType,
    componentVersion: LEARNING_ACTIVITY_VERSION,
    props: input.props,
  };
}

function calculusDocument(): PageDocument {
  let document = createEmptyPageDocument(CALCULUS_NOTEBOOK_ID, SEED_TIME, { paper: "blank" });
  document = appendPage(appendPage(appendPage(document, SEED_TIME), SEED_TIME), SEED_TIME);
  const pageContent = [
    {
      title: "Limits and continuity",
      subtitle: "Read the expression, show the key step, then check your answer.",
      questions: [
        {
          id: "limit-factor",
          prompt: "Evaluate lim x→2 of (x² − 4)/(x − 2).",
          acceptedAnswers: ["4"],
          answerLabel: "Limit and key cancellation",
          hint: "Factor x² − 4 before substituting.",
          explanation: "Factoring gives x + 2 for x ≠ 2, so the limit is 4.",
        },
        {
          id: "piecewise-continuity",
          prompt: "For f(x) = kx + 1 when x < 2 and f(x) = 9 when x ≥ 2, choose k so f is continuous at 2.",
          acceptedAnswers: ["4", "k=4"],
          answerLabel: "Value of k",
          hint: "Set the left-hand expression at x = 2 equal to 9.",
          explanation: "Continuity requires 2k + 1 = 9, which gives k = 4.",
        },
        {
          id: "trig-limit",
          prompt: "Evaluate lim x→0 of sin(x)/x.",
          acceptedAnswers: ["1"],
          answerLabel: "Limit",
          hint: "Use the standard trigonometric limit.",
          explanation: "The standard limit sin(x)/x approaches 1 as x approaches 0.",
        },
      ],
    },
    {
      title: "Derivative rules",
      subtitle: "Name the rule you use. Leave each answer in a clean equivalent form.",
      questions: [
        {
          id: "product-rule",
          prompt: "Differentiate f(x) = x³eˣ.",
          acceptedAnswers: ["e^x(x^3+3x^2)", "x^3e^x+3x^2e^x", "eˣ(x³+3x²)"],
          answerLabel: "f′(x)",
          hint: "Use the product rule, then factor eˣ if you wish.",
          explanation: "The product rule gives 3x²eˣ + x³eˣ.",
        },
        {
          id: "chain-rule",
          prompt: "Differentiate y = sin(x²).",
          acceptedAnswers: ["2xcos(x^2)", "2x*cos(x^2)", "2x cos(x²)"],
          answerLabel: "dy/dx",
          hint: "Differentiate the outer sine, then multiply by the derivative of x².",
          explanation: "The chain rule gives 2x cos(x²).",
        },
        {
          id: "implicit-rule",
          prompt: "If x² + y² = 25, find dy/dx.",
          acceptedAnswers: ["-x/y", "−x/y"],
          answerLabel: "dy/dx",
          hint: "Differentiate both sides with respect to x and solve for y′.",
          explanation: "2x + 2yy′ = 0, so y′ = −x/y.",
        },
      ],
    },
    {
      title: "Applications of derivatives",
      subtitle: "Translate each situation into a derivative statement before solving.",
      questions: [
        {
          id: "tangent-line",
          prompt: "Find the tangent line to y = x² at x = 3.",
          acceptedAnswers: ["y=6x-9", "y-9=6(x-3)"],
          answerLabel: "Equation of the tangent line",
          hint: "The point is (3, 9), and the slope comes from y′ = 2x.",
          explanation: "The slope is 6, so y − 9 = 6(x − 3), or y = 6x − 9.",
        },
        {
          id: "critical-points",
          prompt: "Find the critical x-values of f(x) = x³ − 3x.",
          acceptedAnswers: ["x=-1,1", "-1,1", "x=−1,1", "x=1,-1"],
          answerLabel: "Critical x-values",
          hint: "Set f′(x) = 3x² − 3 equal to zero.",
          explanation: "3(x² − 1) = 0 at x = −1 and x = 1.",
        },
        {
          id: "optimization",
          prompt: "A rectangle lies under y = 12 − x in the first quadrant. Which x maximizes A = x(12 − x)?",
          acceptedAnswers: ["6", "x=6"],
          answerLabel: "Maximizing x-value",
          hint: "Differentiate A(x) = 12x − x² and set A′(x) to zero.",
          explanation: "A′(x) = 12 − 2x, so the maximum occurs at x = 6.",
        },
      ],
    },
    {
      title: "Mini test",
      subtitle: "Work without notes first. Check once, review the feedback, then retry.",
      questions: [
        {
          id: "mini-limit",
          prompt: "Evaluate lim x→∞ of (5x² − 1)/(2x² + 7).",
          acceptedAnswers: ["5/2", "2.5"],
          answerLabel: "Limit",
          hint: "Compare the leading coefficients.",
          explanation: "Equal polynomial degrees give the ratio of leading coefficients, 5/2.",
        },
        {
          id: "mini-derivative",
          prompt: "Differentiate g(x) = ln(3x + 1).",
          acceptedAnswers: ["3/(3x+1)", "3/(1+3x)"],
          answerLabel: "g′(x)",
          hint: "Use d/dx[ln u] = u′/u.",
          explanation: "With u = 3x + 1 and u′ = 3, g′(x) = 3/(3x + 1).",
        },
        {
          id: "mini-motion",
          prompt: "A particle has s(t) = t³ − 6t² + 9t. Find its velocity at t = 2.",
          acceptedAnswers: ["-3", "−3", "v(2)=-3"],
          answerLabel: "v(2)",
          hint: "Velocity is s′(t). Differentiate, then substitute t = 2.",
          explanation: "v(t) = 3t² − 12t + 9, so v(2) = −3.",
        },
      ],
    },
  ] as const;

  const pages = document.pages.map((page, index) => {
    const content = pageContent[index]!;
    return {
      ...page,
      paper: "blank" as const,
      elements: [
        textElement({
          key: `calc:${index}:heading`,
          label: content.title,
          kind: "heading",
          y: 66,
          height: 156,
          text: content.title,
          followingText: content.subtitle,
        }),
        activityElement({
          key: `calc:${index}:activity`,
          label: `${content.title} practice`,
          componentType: CALCULUS_PRACTICE_COMPONENT,
          props: {
            kind: CALCULUS_PRACTICE_COMPONENT,
            title: content.title,
            directions: content.subtitle,
            questions: content.questions.map((question) => ({ ...question, acceptedAnswers: [...question.acceptedAnswers] })),
          },
        }),
      ],
    };
  });
  return validatePageDocument({ ...document, pages });
}

function coloringDocument(): PageDocument {
  let document = createEmptyPageDocument(COLORING_NOTEBOOK_ID, SEED_TIME, { paper: "blank" });
  document = appendPage(appendPage(document, SEED_TIME), SEED_TIME);
  const pages = [
    { scene: "garden", title: "Garden geometry", prompt: "Build a palette from the center flower outward. Trace, shade, or add your own marks." },
    { scene: "tide-pool", title: "Tide-pool study", prompt: "Color the kelp, shell, fish, and bubbles. The eraser removes only your added color." },
    { scene: "night-moths", title: "Moths after dark", prompt: "Use the moon as a light source. Try broad areas first, then add small pen details." },
  ] as const;
  return validatePageDocument({
    ...document,
    pages: document.pages.map((page, index) => {
      const content = pages[index]!;
      return {
        ...page,
        paper: "blank" as const,
        elements: [
          activityElement({
            key: `coloring:${index}:activity`,
            label: `${content.title} coloring page`,
            componentType: COLORING_BOOK_COMPONENT,
            frame: { x: 0, y: 0, width: 816, height: 1056 },
            props: {
              kind: COLORING_BOOK_COMPONENT,
              scene: content.scene,
              title: content.title,
              prompt: content.prompt,
              strokes: [],
            },
          }),
        ],
      };
    }),
  });
}

function instructionDocument(): PageDocument {
  let document = createEmptyPageDocument(INSTRUCTION_NOTEBOOK_ID, SEED_TIME, { paper: "blank" });
  document = appendPage(appendPage(document, SEED_TIME), SEED_TIME);
  const pages = document.pages.map((page) => {
    if (page.number === 1) {
      return {
        ...page,
        elements: [
          textElement({ key: "welcome", label: "Welcome", kind: "heading", y: 76, height: 190, text: "Welcome to Project: Notebook", followingText: "Ask for notes, diagrams, study help, or a new notebook. The agent works directly on the visible pages." }),
          textElement({ key: "ask", label: "How to begin", kind: "heading", y: 340, height: 250, text: "Say what you want done", followingText: "Give the agent a finished outcome in plain language. It can format writing, add pages, build diagrams, place drawings, and arrange the page for you." }),
          textElement({ key: "controls", label: "Notebook controls", kind: "heading", y: 680, height: 245, text: "The book stays in your hands", followingText: "Turn pages with Previous and Next. Choose one or two pages, zoom with the mouse wheel, use Pan to drag the book, or press Reset to center it at 100%." }),
        ],
      };
    }
    if (page.number === 2) {
      return {
        ...page,
        elements: [
          textElement({ key: "tour", label: "Demo tour", kind: "heading", y: 76, height: 130, text: "Three demos, three kinds of work", followingText: "Open any notebook from the Shelf." }),
          textElement({ key: "anatomy", label: "Anatomy demo", kind: "heading", y: 270, height: 185, text: "Anatomy exam prep", followingText: "Rotate and zoom the adult skeleton, isolate body regions, study named structures, and test yourself." }),
          textElement({ key: "calculus", label: "Calculus demo", kind: "heading", y: 520, height: 180, text: "Calculus I test prep", followingText: "Practice limits, derivatives, and applications. Enter an answer for a check, hint, and focused feedback." }),
          textElement({ key: "coloring", label: "Coloring demo", kind: "heading", y: 770, height: 185, text: "Field Notes Coloring Book", followingText: "Color a child-level traced illustration with pen, eraser, palette, stroke size, Undo, and Clear." }),
        ],
      };
    }
    return {
      ...page,
      elements: [
        textElement({ key: "play", label: "Create a notebook", kind: "heading", y: 76, height: 180, text: "Make a notebook to play with", followingText: "The demo allows one visitor-created notebook. Longer writing adds pages automatically." }),
        textElement({ key: "create-prompt", label: "Complete creation prompt", kind: "quote", y: 300, height: 160, text: "Create Demo Scratchpad with a checklist and a flow: idea, draft, review, done." }),
        textElement({ key: "agent-contract", label: "Agent contract", kind: "heading", y: 520, height: 235, text: "For the agent", followingText: "Use notebook_read for exact context. Use notebook_open for pages and view reset. Use notebook_apply to create, write, draw, arrange, add pages, or undo. Act directly on reversible requests." }),
        textElement({ key: "reset-undo", label: "Reset and Undo", kind: "heading", y: 820, height: 180, text: "Reset the view, undo the work", followingText: "Reset centers the book at 100% and turns Pan off. Undo reverses the latest compatible agent change." }),
      ],
    };
  });
  return validatePageDocument({ ...document, pages });
}

function anatomyDocument(): PageDocument {
  const empty = createEmptyPageDocument(ANATOMY_NOTEBOOK_ID, SEED_TIME);
  const proposal = createAnatomyCompositionProposal(empty);
  return applyAnatomyComposition({
    document: empty,
    proposalId: proposal.proposalId,
    expectedDocumentRevision: empty.documentRevision,
    at: SEED_TIME,
  }).document;
}

class SessionWorkspacePersistence implements WorkspacePersistence {
  private readonly inbox = seedNotebook(INBOX_ID, "Inbox", "Quick notes", 0);
  private readonly notebooks = new Map<NotebookId, Notebook>([
    [INSTRUCTION_NOTEBOOK_ID, seedNotebook(INSTRUCTION_NOTEBOOK_ID, "Instruction Notebook", "Start here for the demo tour, agent controls, and a practice notebook", 1)],
    [ANATOMY_NOTEBOOK_ID, seedNotebook(ANATOMY_NOTEBOOK_ID, "Anatomy exam prep", "Study, test, and color the adult skeleton", 2)],
    [CALCULUS_NOTEBOOK_ID, seedNotebook(CALCULUS_NOTEBOOK_ID, "Calculus I test prep", "Limits, derivatives, applications, and immediate feedback", 3)],
    [COLORING_NOTEBOOK_ID, seedNotebook(COLORING_NOTEBOOK_ID, "Field Notes Coloring Book", "Three drawing pages with practical coloring tools", 4)],
  ]);
  private readonly sessionCache = browserSessionCache();
  private metadata: WorkspaceMetadata = {
    id: "workspace",
    version: 1,
    inboxNotebookId: INBOX_ID,
    currentTargetNotebookId: INBOX_ID,
    revision: createRevision(1),
    updatedAt: SEED_TIME,
  };

  public constructor() {
    const serialized = this.sessionCache?.getItem(NOTEBOOK_SESSION_KEY);
    if (serialized !== null && serialized !== undefined) {
      try {
        const value: unknown = JSON.parse(serialized);
        if (Array.isArray(value)) {
          for (const row of value) {
            const notebook = parseNotebookRow(row);
            if (notebook.id !== INBOX_ID) this.notebooks.set(notebook.id, notebook);
          }
        }
      } catch {
        this.persistNotebooks();
      }
    }
    this.persistNotebooks();
  }

  private persistNotebooks(): void {
    this.sessionCache?.setItem(
      NOTEBOOK_SESSION_KEY,
      JSON.stringify([...this.notebooks.values()].map(notebookToRow)),
    );
  }

  public async bootstrap(): Promise<WorkspaceBootstrap> {
    return { inbox: this.inbox, notebooks: [...this.notebooks.values()], metadata: this.metadata, issues: [] };
  }

  public async getNotebook(id: NotebookId): Promise<Notebook | null> {
    return id === this.inbox.id ? this.inbox : this.notebooks.get(id) ?? null;
  }

  public async createNotebook(notebook: Notebook): Promise<Notebook> {
    if (this.notebooks.size >= DEMO_WORKSPACE_LIMITS.totalNotebooks) {
      throw new Error("This playground allows one visitor-created notebook per reload.");
    }
    this.notebooks.set(notebook.id, notebook);
    this.persistNotebooks();
    return notebook;
  }

  public async updateNotebook(notebook: Notebook, expectedRevision: Revision): Promise<Notebook> {
    const current = await this.getNotebook(notebook.id);
    if (current === null || current.revision !== expectedRevision) throw new Error("The notebook revision is stale.");
    if (notebook.id !== this.inbox.id) {
      this.notebooks.set(notebook.id, notebook);
      this.persistNotebooks();
    }
    return notebook;
  }

  public async setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata> {
    if ((await this.getNotebook(id)) === null) throw new Error("Notebook not found.");
    if (this.metadata.currentTargetNotebookId === id) return this.metadata;
    this.metadata = {
      ...this.metadata,
      currentTargetNotebookId: id,
      revision: createRevision(this.metadata.revision + 1),
      updatedAt: createIsoInstant(new Date().toISOString()),
    };
    return this.metadata;
  }

  public async execute(): Promise<WorkspaceOperationResult> {
    return { ok: false, code: "invalid_target" };
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

export type DemoSessionContext = Readonly<{
  pageStorage: SessionPageStorage;
}>;

export type DemoWorkspaceRuntime = Readonly<{
  controller: WorkspaceController;
  session: DemoSessionContext;
  cleanup: () => Promise<void>;
}>;

export function createDemoWorkspaceRuntime(): DemoWorkspaceRuntime {
  const pageStorage = new SessionPageStorage([
    createEmptyPageDocument(INBOX_ID, SEED_TIME, { paper: "blank" }),
    instructionDocument(),
    anatomyDocument(),
    calculusDocument(),
    coloringDocument(),
  ]);
  const persistence = new SessionWorkspacePersistence();
  const controller = createWorkspaceController(persistence, createBrowserWorkspaceHistory());
  return {
    controller,
    session: {
      pageStorage,
    },
    cleanup: async (): Promise<void> => {
      await controller.dispose();
      await Promise.all([persistence.close(), pageStorage.close()]);
    },
  };
}

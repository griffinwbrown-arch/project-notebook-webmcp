import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Home from "../../../src/app/page";
import DeskPage from "../../../src/app/desk/page";
import RootLayout, { metadata } from "../../../src/app/layout";
import manifest from "../../../src/app/manifest";

const routeHarness = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: routeHarness.redirect,
}));

vi.mock("../../../src/entries/desk/DemoDeskDocument", () => ({
  DemoDeskDocument: () => <div data-testid="demo-desk-document-entry" />,
}));

describe("app entry points", () => {
  it("redirects the root entry to the desk", () => {
    Home();

    expect(routeHarness.redirect).toHaveBeenCalledOnce();
    expect(routeHarness.redirect).toHaveBeenCalledWith("/desk");
  });

  it("delegates the desk route to the session-only real app", () => {
    render(<DeskPage />);

    expect(screen.getByTestId("demo-desk-document-entry")).toBeVisible();
  });

  it("keeps the document language, metadata, and manifest start route aligned", () => {
    const layout = RootLayout({ children: <p>Notebook content</p> });

    expect(layout).toMatchObject({ type: "html", props: { lang: "en" } });
    expect(layout.props.children).toMatchObject({
      type: "body",
      props: { children: expect.objectContaining({ type: "p" }) },
    });
    expect(metadata).toEqual({
      title: "Project: Notebook · WebMCP judge demo",
      description: "Use direct, page-scoped WebMCP controls in the real Project: Notebook interface.",
    });
    expect(manifest()).toMatchObject({
      name: "Project Notebook",
      short_name: "Notebook",
      description: "A private Project: Notebook playground with direct WebMCP page and anatomy tools.",
      start_url: "/desk",
      display: "standalone",
      background_color: "#efe8dc",
      theme_color: "#1c1c1b",
    });
    expect(manifest().icons).toEqual([
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
    ]);
  });
});

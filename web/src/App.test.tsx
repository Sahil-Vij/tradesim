import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "./App.tsx";

test("shows the server as online when the health check passes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"ok"}')));
  render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent("Checking server");
  expect(await screen.findByText("Server online")).toBeInTheDocument();
});

test("shows the server as offline when the health check fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  render(<App />);
  expect(await screen.findByText("Server offline")).toBeInTheDocument();
});

test("treats an error response as offline", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
  render(<App />);
  expect(await screen.findByText("Server offline")).toBeInTheDocument();
});

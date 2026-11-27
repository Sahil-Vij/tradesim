import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { RollingNumber } from "./RollingNumber.tsx";

test("reads as plain text, and moves each digit's column to that digit", () => {
  const { container, rerender } = render(<RollingNumber value="$60,695.63" />);
  expect(screen.getByText("$60,695.63")).toBeInTheDocument();
  const strips = () => [...container.querySelectorAll<HTMLElement>(".roll-strip")].map((s) => s.style.transform);
  expect(strips()).toEqual(["6", "0", "6", "9", "5", "6", "3"].map((d) => `translateY(-${Number(d) * 10}%)`));

  rerender(<RollingNumber value="$60,695.71" />);
  expect(strips().slice(-2)).toEqual(["translateY(-70%)", "translateY(-10%)"]);
});

test("keeps digit columns in place when the number grows a digit", () => {
  const { container, rerender } = render(<RollingNumber value="$9.99" />);
  const first = container.querySelectorAll(".roll-digit")[2]; // the last 9
  rerender(<RollingNumber value="$10.00" />);
  // Same element, keyed from the right, so it can animate from 9 to 0 instead of being replaced.
  expect(container.querySelectorAll(".roll-digit")[3]).toBe(first);
});

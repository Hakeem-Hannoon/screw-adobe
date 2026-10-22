// All shape coordinates are in "page points": the page as it appears on screen
// at 100% zoom (PDF points, top-left origin, page rotation already applied).

export type Color = "black" | "white";
export type Tool = "box" | "text";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxShape extends Rect {
  id: string;
  kind: "box";
  page: number; // original page index
  color: Color;
}

export interface TextShape {
  id: string;
  kind: "text";
  page: number;
  x: number;
  y: number;
  text: string;
  size: number; // font size in points
  color: Color;
}

export type Shape = BoxShape | TextShape;

export interface DocState {
  shapes: Shape[];
  deleted: number[]; // original page indices removed from the output
}

export interface PageSize {
  w: number;
  h: number;
}

export const INK: Record<Color, string> = { black: "#000000", white: "#ffffff" };

export const TEXT_FONT = '"Public Sans Variable", "Public Sans", system-ui, sans-serif';
export const TEXT_LINE_HEIGHT = 1.25;

let counter = 0;
export function uid(): string {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

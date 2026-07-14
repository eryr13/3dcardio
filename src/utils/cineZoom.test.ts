import { describe, expect, it } from "vitest";
import { CINE_ZOOM_MAX, CINE_ZOOM_MIN, DEFAULT_CINE_ZOOM, dragPan, zoomAtCursor } from "./cineZoom";

describe("zoomAtCursor", () => {
  it("keeps the cursor's underlying point fixed on screen after zooming in", () => {
    // カーソルを画面の左寄り(0.25)に置いてズームすると、その点が画面上の同じ位置に
    // 留まるようpanが再計算されているはず。
    const next = zoomAtCursor(DEFAULT_CINE_ZOOM, 0.25, 0.5, 2);
    expect(next.zoom).toBeCloseTo(2, 6);
    // ズーム後、同じ点(uCursor)がcursorXNorm=0.25の位置に来ているか逆算して確認する
    const uCursor = 0.5 + next.panX + (0.25 - 0.5) / next.zoom;
    const uCursorBefore = 0.5 + DEFAULT_CINE_ZOOM.panX + (0.25 - 0.5) / DEFAULT_CINE_ZOOM.zoom;
    expect(uCursor).toBeCloseTo(uCursorBefore, 6);
  });

  it("clamps zoom to [CINE_ZOOM_MIN, CINE_ZOOM_MAX]", () => {
    const zoomedOut = zoomAtCursor(DEFAULT_CINE_ZOOM, 0.5, 0.5, 0.1);
    expect(zoomedOut.zoom).toBeCloseTo(CINE_ZOOM_MIN, 6);

    const zoomedIn = zoomAtCursor({ zoom: CINE_ZOOM_MAX, panX: 0, panY: 0 }, 0.5, 0.5, 10);
    expect(zoomedIn.zoom).toBeCloseTo(CINE_ZOOM_MAX, 6);
  });

  it("does not change pan when zooming centered on the viewport center", () => {
    const next = zoomAtCursor(DEFAULT_CINE_ZOOM, 0.5, 0.5, 3);
    expect(next.panX).toBeCloseTo(0, 6);
    expect(next.panY).toBeCloseTo(0, 6);
  });
});

describe("dragPan", () => {
  it("moves pan opposite the crop window so content follows the cursor 1:1", () => {
    const zoomed = { zoom: 2, panX: 0, panY: 0 };
    const dragged = dragPan(zoomed, 0.1, -0.05);
    expect(dragged.panX).toBeCloseTo(-0.05, 6);
    expect(dragged.panY).toBeCloseTo(0.025, 6);
    expect(dragged.zoom).toBe(2);
  });
});

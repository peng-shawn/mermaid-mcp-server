// 2D affine transforms and axis-aligned rectangles, the arithmetic behind
// getBBox, getCTM and friends.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ZERO_RECT: Readonly<Rect> = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export class Matrix {
  constructor(
    readonly a = 1,
    readonly b = 0,
    readonly c = 0,
    readonly d = 1,
    readonly e = 0,
    readonly f = 0
  ) {}

  static translate(x: number, y: number): Matrix {
    return new Matrix(1, 0, 0, 1, x, y);
  }

  multiply(m: Matrix): Matrix {
    return new Matrix(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f
    );
  }

  inverse(): Matrix {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return new Matrix();
    return new Matrix(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det
    );
  }

  apply(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && !this.e && !this.f;
  }

  key(): string {
    return this.isIdentity() ? "" : `${this.a},${this.b},${this.c},${this.d},${this.e},${this.f}`;
  }
}

const TRANSFORM_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
const DEG = Math.PI / 180;

export function parseTransform(value: string | null | undefined): Matrix {
  let m = new Matrix();
  if (!value) return m;
  for (const [, fn, argText] of value.matchAll(TRANSFORM_RE)) {
    const a = argText.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Matrix;
    switch (fn) {
      case "matrix":
        t = new Matrix(a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0);
        break;
      case "translate":
        t = Matrix.translate(a[0] || 0, a[1] || 0);
        break;
      case "scale":
        t = new Matrix(a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0);
        break;
      case "rotate": {
        const r = (a[0] || 0) * DEG;
        t = new Matrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
        if (a.length === 3) t = Matrix.translate(a[1], a[2]).multiply(t).multiply(Matrix.translate(-a[1], -a[2]));
        break;
      }
      case "skewX":
        t = new Matrix(1, 0, Math.tan((a[0] || 0) * DEG), 1, 0, 0);
        break;
      default:
        t = new Matrix(1, Math.tan((a[0] || 0) * DEG), 0, 1, 0, 0);
    }
    m = m.multiply(t);
  }
  return m;
}

// Bounding box of a rectangle after a transform
export function transformRect(r: Rect, m: Matrix): Rect {
  if (m.isIdentity()) return r;
  const pts = [m.apply(r.x, r.y), m.apply(r.x + r.width, r.y), m.apply(r.x, r.y + r.height), m.apply(r.x + r.width, r.y + r.height)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// Union that keeps empty rectangles' positions (gfx::RectF::UnionEvenIfEmpty)
export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function pointsRect(points: Array<[number, number]>): Rect | null {
  if (!points.length) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

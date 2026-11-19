import { Map, Box, Room, Note, Block, Connector } from "./models";
import { Direction, LineStyle, RoomShape, ConnectorType } from "./enums";
import { MarkdownParser, TextSegment } from "./util/MarkdownParser";
import { DrawContext } from "./drawing/drawContext";

//
// The SvgExporter exports the map to an SVG file.
//
export class SvgExporter {
  private map: Map;
  private left: number;
  private top: number;
  private width: number;
  private height: number;
  private padding: number = 50;

  public constructor(map: Map) {
    this.map = map;
  }

  //
  // Export the current map to an SVG file.
  //
  public async export() {
    // Calculate bounding box
    this.calculateBounds();

    // Load fonts as base64
    const fontStyles = await this.loadFonts();

    // Generate SVG content
    const svg = this.generateSvg(fontStyles);

    // Download
    this.download(svg);
  }

  //
  // Load fonts and convert to base64 for embedding.
  //
  private async loadFonts(): Promise<string> {
    const fonts: { name: string, url: string, weight: string, style: string }[] = [
      { name: 'danielbd', url: 'fonts/danielbd.woff2', weight: 'normal', style: 'normal' },
      { name: 'Roboto', url: 'fonts/roboto-v20-latin-regular.woff2', weight: '400', style: 'normal' }
    ];

    const fontFaces: string[] = [];

    for (const font of fonts) {
      try {
        const response = await fetch(font.url);
        if (response.ok) {
          const blob = await response.blob();
          const base64 = await this.blobToBase64(blob);
          fontFaces.push(`
      @font-face {
        font-family: '${font.name}';
        src: url(${base64}) format('woff2');
        font-weight: ${font.weight};
        font-style: ${font.style};
      }`);
        }
      } catch (e) {
        // Font not available, skip it
        console.warn(`Could not load font: ${font.name}`);
      }
    }

    return fontFaces.join('\n');
  }

  //
  // Convert a Blob to a base64 data URL.
  //
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  //
  // Calculate the bounding box of all elements.
  //
  private calculateBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    this.map.elements.forEach((model) => {
      if (model instanceof Box) {
        if (model.x < minX) minX = model.x;
        if (model.y < minY) minY = model.y;
        if (model.x + model.width > maxX) maxX = model.x + model.width;
        if (model.y + model.height > maxY) maxY = model.y + model.height;
      } else if (model instanceof Connector) {
        // Include connector endpoints
        const points = this.getConnectorPoints(model);
        points.forEach(p => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });
      }
    });

    // Handle empty map
    if (minX === Infinity) {
      minX = 0;
      minY = 0;
      maxX = 100;
      maxY = 100;
    }

    this.left = minX - this.padding;
    this.top = minY - this.padding;
    this.width = maxX - minX + this.padding * 2;
    this.height = maxY - minY + this.padding * 2;
  }

  //
  // Get all points of a connector for bounds calculation.
  //
  private getConnectorPoints(conn: Connector): { x: number, y: number }[] {
    const points: { x: number, y: number }[] = [];

    if (conn.dockStart) {
      const pos = conn.dockStart.directionToPos(conn.startDir, false);
      points.push(pos);
    } else {
      points.push({ x: conn.startX, y: conn.startY });
    }

    if (conn.dockEnd) {
      const pos = conn.dockEnd.directionToPos(conn.endDir, false);
      points.push(pos);
    } else {
      points.push({ x: conn.endX, y: conn.endY });
    }

    // A curve can bulge outside its end points; its control points bound it.
    if (conn.isCurve && points.length == 2) {
      const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) * this.map.settings.connector.curveStrength
        + this.map.settings.connector.stalk;
      if (conn.dockStart) {
        const v = Direction.toCardinalVector(conn.startDir);
        points.push({ x: points[0].x + v.x * dist, y: points[0].y + v.y * dist });
      }
      if (conn.dockEnd) {
        const v = Direction.toCardinalVector(conn.endDir);
        points.push({ x: points[1].x + v.x * dist, y: points[1].y + v.y * dist });
      }
    }

    return points;
  }

  //
  // Generate the complete SVG markup.
  //
  private generateSvg(fontStyles: string): string {
    const parts: string[] = [];

    // SVG header
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${this.left} ${this.top} ${this.width} ${this.height}" width="${this.width}" height="${this.height}">`);

    // Embedded fonts
    if (fontStyles) {
      parts.push(`  <defs>`);
      parts.push(`    <style type="text/css">`);
      parts.push(fontStyles);
      parts.push(`    </style>`);
      parts.push(`  </defs>`);
    }

    // Background
    parts.push(`  <rect x="${this.left}" y="${this.top}" width="${this.width}" height="${this.height}" fill="${this.map.settings.grid.background}"/>`);

    // Draw blocks first (behind everything)
    this.map.elements.forEach((model) => {
      if (model instanceof Block) {
        parts.push(this.renderBlock(model));
      }
    });

    // Draw connectors (behind rooms but above blocks)
    this.map.elements.forEach((model) => {
      if (model instanceof Connector) {
        parts.push(this.renderConnector(model));
      }
    });

    // Draw rooms and notes
    this.map.elements.forEach((model) => {
      if (model instanceof Room) {
        parts.push(this.renderRoom(model));
      } else if (model instanceof Note) {
        parts.push(this.renderNote(model));
      }
    });

    parts.push(`</svg>`);

    return parts.join('\n');
  }

  //
  // Convert LineStyle to SVG stroke-dasharray.
  //
  private lineStyleToDashArray(style: LineStyle): string {
    const arr = LineStyle.toArray(style);
    return arr.length > 0 ? arr.join(',') : 'none';
  }

  //
  // Hand-drawn style: run the same DrawContext the editor uses, but record its
  // moveTo/quadraticCurveTo calls as SVG path data instead of drawing on a canvas.
  // Seeded with the element's id, like the editor, so the wobble is stable.
  //
  private get handdrawn(): boolean {
    return !!this.map.settings.basic.handdrawn;
  }

  private hdPath(seed: number, x0: number, y0: number, draw: (dc: DrawContext) => void): string {
    // DrawContext continues from the canvas's current point; an SVG path must start with M.
    const d: string[] = [`M ${x0} ${y0}`];
    const recorder = {
      moveTo: (x: number, y: number) => d.push(`M ${x} ${y}`),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => d.push(`Q ${cx} ${cy} ${x} ${y}`),
    };
    const dc = new DrawContext(recorder as any);
    dc.seed(seed);
    draw(dc);
    return d.join(' ');
  }

  // Outline of a box: hand-drawn when the map asks for it, otherwise the exact shape.
  private getOutlinePath(box: Box): string {
    if (!this.handdrawn) return this.getShapePath(box);
    const { x, y, width: w, height: h } = box;
    const r = Math.min(box.rounding || 0, w / 4, h / 4);
    const start = box.shape == RoomShape.Ellipse ? [x + w, y + h / 2] : box.shape == RoomShape.Octagon ? [x, y + h * 0.25] : [x + r, y];
    return this.hdPath(box.id, start[0], start[1], (dc) => {
      switch (box.shape) {
        case RoomShape.Ellipse: dc.hdEllipse(x + w / 2, y + h / 2, w / 2, h / 2); break;
        case RoomShape.Octagon: dc.hdOctagon(x, y, w, h); break;
        default: dc.hdRoundedRect(x, y, w, h, r);
      }
    });
  }

  //
  // Generate SVG shape path for a box (room/note/block).
  //
  private getShapePath(box: Box): string {
    const x = box.x;
    const y = box.y;
    const w = box.width;
    const h = box.height;
    const r = Math.min(box.rounding || 0, w / 4, h / 4);

    switch (box.shape) {
      case RoomShape.Ellipse:
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;
        return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;

      case RoomShape.Octagon:
        const cut = Math.min(w, h) * 0.25;
        return `M ${x + cut} ${y} L ${x + w - cut} ${y} L ${x + w} ${y + cut} L ${x + w} ${y + h - cut} L ${x + w - cut} ${y + h} L ${x + cut} ${y + h} L ${x} ${y + h - cut} L ${x} ${y + cut} Z`;

      default: // Rectangle with optional rounding
        if (r > 0) {
          return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
        }
        return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    }
  }

  //
  // Escape text for XML.
  //
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  //
  // Get SVG style attributes for a text segment.
  //
  private getSegmentStyle(segment: TextSegment): string {
    const styles: string[] = [];
    if (segment.bold) {
      styles.push('font-weight="bold"');
    }
    if (segment.italic) {
      styles.push('font-style="italic"');
    }
    return styles.length > 0 ? ' ' + styles.join(' ') : '';
  }

  //
  // Render a single line of text with markdown support.
  //
  private renderMarkdownText(text: string, x: number, y: number, fontSize: number, fontFamily: string, color: string): string {
    const segments = MarkdownParser.parse(text);
    let result = `    <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}">`;

    for (const segment of segments) {
      const style = this.getSegmentStyle(segment);
      if (style) {
        result += `<tspan${style}>${this.escapeXml(segment.text)}</tspan>`;
      } else {
        result += this.escapeXml(segment.text);
      }
    }

    result += `</text>`;
    return result;
  }

  //
  // Estimate the width of a text in pixels. SVG output has no canvas to
  // measure with, so use average glyph widths (as a fraction of the font size)
  // for a proportional sans-serif font.
  //
  private textWidth(text: string, fontSize: number, bold: boolean = false): number {
    let w = 0;
    for (const ch of text) {
      if ("iljI.,:;'!|".includes(ch)) w += 0.28;
      else if ("ftr()[] -\"".includes(ch)) w += 0.36;
      else if ("mwMW@".includes(ch)) w += 0.85;
      else if (ch >= 'A' && ch <= 'Z') w += 0.66;
      else w += 0.54;
    }
    // danielbd (the hand-drawn style's font) runs wider than a regular sans-serif
    const fontFactor = this.map.settings.basic.fontFamily.includes('danielbd') ? 1.25 : 1;
    return w * fontSize * fontFactor * (bold ? 1.08 : 1);
  }

  //
  // Word-wrap text (with markdown) into lines no wider than maxWidth,
  // respecting explicit line breaks. Mirrors Canvas.drawText.
  //
  private wrapText(text: string, maxWidth: number, fontSize: number): TextSegment[][] {
    if (maxWidth < 50) maxWidth = 50;
    const lines: TextSegment[][] = [];
    for (const paragraph of text.split('\n')) {
      if (paragraph.trim() === '') {
        lines.push([{ text: '', bold: false, italic: false }]);
        continue;
      }
      let line: TextSegment[] = [];
      let width = 0;
      for (const segment of MarkdownParser.parse(paragraph)) {
        const words = segment.text.split(' ');
        for (let i = 0; i < words.length; i++) {
          const word = i < words.length - 1 ? words[i] + ' ' : words[i];
          const ww = this.textWidth(word.trimEnd(), fontSize, segment.bold);
          if (width + ww > maxWidth && line.length > 0) {
            lines.push(line);
            line = [];
            width = 0;
          }
          const last = line[line.length - 1];
          if (last && last.bold === segment.bold && last.italic === segment.italic) {
            last.text += word;
          } else {
            line.push({ text: word, bold: segment.bold, italic: segment.italic });
          }
          width += this.textWidth(word, fontSize, segment.bold);
        }
      }
      if (line.length > 0) lines.push(line);
    }
    // Remove trailing spaces at line ends.
    lines.forEach(l => { if (l.length) l[l.length - 1].text = l[l.length - 1].text.trimEnd(); });
    return lines;
  }

  //
  // Render word-wrapped text (with markdown) centred on (cx, cy).
  //
  private renderWrappedText(text: string, cx: number, cy: number, maxWidth: number, fontSize: number,
                            fontFamily: string, color: string): string {
    const lines = this.wrapText(text, maxWidth, fontSize);
    const lineHeight = Math.ceil(fontSize) + 1;
    let y = cy - (lines.length - 1) * lineHeight / 2;
    const out: string[] = [];
    for (const segments of lines) {
      let t = `    <text x="${cx}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}">`;
      for (const segment of segments) {
        const style = this.getSegmentStyle(segment);
        t += style ? `<tspan${style}>${this.escapeXml(segment.text)}</tspan>` : this.escapeXml(segment.text);
      }
      out.push(t + `</text>`);
      y += lineHeight;
    }
    return out.join('\n');
  }

  //
  // Render a room to SVG.
  //
  private renderRoom(room: Room): string {
    const parts: string[] = [];
    const path = this.getShapePath(room);
    const dashArray = this.lineStyleToDashArray(room.lineStyle);

    parts.push(`  <g class="room">`);

    // Fill
    parts.push(`    <path d="${path}" fill="${room.fillColor}" stroke="none"/>`);

    // Darkness indicator (diagonal stripe in top-right)
    if (room.dark) {
      const darkColor = this.map.settings.room.darkColor;
      const stripeSize = Math.min(room.width, room.height) * 0.3;
      parts.push(`    <clipPath id="dark-clip-${room.id}">`);
      parts.push(`      <path d="${path}"/>`);
      parts.push(`    </clipPath>`);
      parts.push(`    <polygon points="${room.x + room.width - stripeSize},${room.y} ${room.x + room.width},${room.y} ${room.x + room.width},${room.y + stripeSize}" fill="${darkColor}" clip-path="url(#dark-clip-${room.id})"/>`);
    }

    // Border
    if (room.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${this.getOutlinePath(room)}" fill="none" stroke="${room.borderColor}" stroke-width="${room.lineWidth}"${strokeDash}/>`);
    }

    // Room name with markdown support
    const fontSize = this.map.settings.basic.fontSize;
    const fontFamily = this.map.settings.basic.fontFamily;
    const cx = room.x + room.width / 2;
    const cy = room.y + room.height / 2;

    const margin = this.map.settings.room.margin || 0;
    parts.push(this.renderWrappedText(room.name, cx, cy, room.width - margin * 2, fontSize, fontFamily, room.nameColor));

    // Subtitle with markdown support, word-wrapped and aligned to the bottom (like the editor)
    if (room.subtitle) {
      const subtitleSize = fontSize * 0.8;
      const lines = this.wrapText(room.subtitle, room.width - margin * 2, subtitleSize).length;
      const lineHeight = Math.ceil(subtitleSize) + 1;
      const sy = room.y + room.height - 5 - lineHeight / 2 - (lines - 1) * lineHeight / 2;
      parts.push(this.renderWrappedText(room.subtitle, cx, sy, room.width - margin * 2, subtitleSize, fontFamily, room.subtitleColor));
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a note to SVG.
  //
  private renderNote(note: Note): string {
    const parts: string[] = [];
    const path = this.getShapePath(note);
    const dashArray = this.lineStyleToDashArray(note.lineStyle);

    parts.push(`  <g class="note">`);

    // Fill
    parts.push(`    <path d="${path}" fill="${note.fillColor}" stroke="none"/>`);

    // Fold corner (diagonal line in corner)
    const foldSize = note.height * 0.15;
    parts.push(`    <line x1="${note.x + note.width - foldSize}" y1="${note.y}" x2="${note.x + note.width}" y2="${note.y + foldSize}" stroke="${note.borderColor}" stroke-width="${note.lineWidth / 2}"/>`);

    // Border
    if (note.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${this.getOutlinePath(note)}" fill="none" stroke="${note.borderColor}" stroke-width="${note.lineWidth}"${strokeDash}/>`);
    }

    // Text with markdown support
    const fontSize = this.map.settings.basic.fontSize;
    const fontFamily = this.map.settings.basic.fontFamily;
    const cx = note.x + note.width / 2;
    const lineHeight = fontSize * 1.2;

    // Split by newlines and render each line
    const lines = note.text.split('\n');
    const totalHeight = lines.length * lineHeight;
    const startY = note.y + note.height / 2 - totalHeight / 2 + lineHeight / 2;

    lines.forEach((line, lineIndex) => {
      const lineY = startY + lineIndex * lineHeight;
      const segments = MarkdownParser.parse(line);

      parts.push(`    <text x="${cx}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${note.textColor}" font-size="${fontSize}" font-family="${fontFamily}">`);

      segments.forEach(segment => {
        const style = this.getSegmentStyle(segment);
        if (style) {
          parts.push(`<tspan${style}>${this.escapeXml(segment.text)}</tspan>`);
        } else {
          parts.push(this.escapeXml(segment.text));
        }
      });

      parts.push(`</text>`);
    });

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a block to SVG.
  //
  private renderBlock(block: Block): string {
    const parts: string[] = [];
    const path = this.getShapePath(block);
    const dashArray = this.lineStyleToDashArray(block.lineStyle);

    parts.push(`  <g class="block">`);

    // Fill
    parts.push(`    <path d="${path}" fill="${block.fillColor}" stroke="none"/>`);

    // Border
    if (block.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${this.getOutlinePath(block)}" fill="none" stroke="${block.borderColor}" stroke-width="${block.lineWidth}"${strokeDash}/>`);
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a connector to SVG.
  //
  private renderConnector(conn: Connector): string {
    const parts: string[] = [];
    const dashArray = this.lineStyleToDashArray(conn.lineStyle);

    // Get start and end points
    let startX: number, startY: number, endX: number, endY: number;
    let startDir: Direction, endDir: Direction;

    if (conn.dockStart) {
      const pos = conn.dockStart.directionToPos(conn.startDir, false);
      startX = pos.x;
      startY = pos.y;
      startDir = conn.startDir;
    } else {
      startX = conn.startX;
      startY = conn.startY;
      startDir = conn.startDir;
    }

    if (conn.dockEnd) {
      const pos = conn.dockEnd.directionToPos(conn.endDir, false);
      endX = pos.x;
      endY = pos.y;
      endDir = conn.endDir;
    } else {
      endX = conn.endX;
      endY = conn.endY;
      endDir = conn.endDir;
    }

    parts.push(`  <g class="connector">`);

    // Same geometry as ConnectorView: a docked end has a stalk that leaves the
    // room in its direction; the line (or curve) runs between the stalk ends.
    const settings = this.map.settings.connector;
    const stalkEnd = (room: Room, dir: Direction) => {
      const r = room.directionToPos(dir, true);
      const v = Direction.toCardinalVector(dir);
      return { x: r.x + v.x * settings.stalk, y: r.y + v.y * settings.stalk };
    };
    const dockStartX = startX, dockStartY = startY, dockEndX = endX, dockEndY = endY;
    if (conn.dockStart) ({ x: startX, y: startY } = stalkEnd(conn.dockStart, startDir));
    if (conn.dockEnd) ({ x: endX, y: endY } = stalkEnd(conn.dockEnd, endDir));

    // Points along the path, for arrows and labels (fraction t of the way).
    let pointAt = (t: number) => ({ x: startX + (endX - startX) * t, y: startY + (endY - startY) * t,
                                     a: Math.atan2(endY - startY, endX - startX) });

    let pathD = conn.dockStart ? `M ${dockStartX} ${dockStartY} L ${startX} ${startY}` : `M ${startX} ${startY}`;
    // the same path as hand-drawn strokes (used when the map is hand-drawn)
    const hd: ((dc: DrawContext) => void)[] = [];
    if (conn.dockStart) hd.push(dc => dc.hdLine(dockStartX, dockStartY, startX, startY));
    if (conn.isCurve && (conn.dockStart || conn.dockEnd)) {
      const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2) * settings.curveStrength;
      if (conn.dockStart && conn.dockEnd) {
        const v1 = Direction.toCardinalVector(startDir), v2 = Direction.toCardinalVector(endDir);
        const c1x = startX + v1.x * dist, c1y = startY + v1.y * dist;
        const c2x = endX + v2.x * dist, c2y = endY + v2.y * dist;
        pathD += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${endX} ${endY}`;
        hd.push(dc => dc.hdBezier3(startX, startY, c1x, c1y, c2x, c2y, endX, endY));
        pointAt = (t: number) => {
          const u = 1 - t;
          const x = u*u*u*startX + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*endX;
          const y = u*u*u*startY + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*endY;
          const dx = 3*u*u*(c1x - startX) + 6*u*t*(c2x - c1x) + 3*t*t*(endX - c2x);
          const dy = 3*u*u*(c1y - startY) + 6*u*t*(c2y - c1y) + 3*t*t*(endY - c2y);
          return { x, y, a: Math.atan2(dy, dx) };
        };
      } else {
        const v = Direction.toCardinalVector(conn.dockStart ? startDir : endDir);
        const cx = (conn.dockStart ? startX : endX) + v.x * dist;
        const cy = (conn.dockStart ? startY : endY) + v.y * dist;
        pathD += ` Q ${cx} ${cy} ${endX} ${endY}`;
        hd.push(dc => dc.hdBezier2(startX, startY, cx, cy, endX, endY));
        pointAt = (t: number) => {
          const u = 1 - t;
          const x = u*u*startX + 2*u*t*cx + t*t*endX;
          const y = u*u*startY + 2*u*t*cy + t*t*endY;
          return { x, y, a: Math.atan2(2*u*(cy - startY) + 2*t*(endY - cy), 2*u*(cx - startX) + 2*t*(endX - cx)) };
        };
      }
    } else {
      pathD += ` L ${endX} ${endY}`;
      hd.push(dc => dc.hdLine(startX, startY, endX, endY));
    }
    if (conn.dockEnd) pathD += ` L ${dockEndX} ${dockEndY}`;
    if (conn.dockEnd) hd.push(dc => dc.hdLine(endX, endY, dockEndX, dockEndY));
    if (this.handdrawn) pathD = this.hdPath(conn.id, dockStartX, dockStartY, dc => hd.forEach(f => f(dc)));

    const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
    parts.push(`    <path d="${pathD}" fill="none" stroke="${conn.color}" stroke-width="${conn.lineWidth}" stroke-linecap="round" stroke-linejoin="round"${strokeDash}/>`);

    const p1 = pointAt(0.1), p2 = pointAt(0.9), pc = pointAt(0.5);

    // One-way arrows, near both ends (as in the editor)
    if (conn.oneWay) {
      for (const p of [p1, p2]) {
        parts.push(`    <polygon points="${this.getArrowPoints(p.x, p.y, p.a, settings.arrowSize)}" fill="${conn.color}"/>`);
      }
    }

    const fontFamily = this.map.settings.basic.fontFamily;
    const baseSize = this.map.settings.basic.fontSize;

    // Connector name label
    if (conn.name) {
      const textWidth = this.textWidth(conn.name, baseSize);
      parts.push(`    <rect x="${pc.x - textWidth / 2 - 5}" y="${pc.y - 11}" width="${textWidth + 10}" height="20" fill="#fff" stroke="#000" stroke-width="1" rx="3"/>`);
      parts.push(`    <text x="${pc.x}" y="${pc.y}" text-anchor="middle" dominant-baseline="middle" fill="#333" font-size="${baseSize}" font-family="${fontFamily}">${this.escapeXml(conn.name)}</text>`);
    }

    // Start and end labels (up/dn/in/out or custom), beside the line near each end
    const labelSize = baseSize * 0.7;
    const startText = conn.startLabel ? conn.startLabel : ConnectorType.toString(conn.startType);
    const endText = conn.endLabel ? conn.endLabel : ConnectorType.toString(conn.endType);
    if (startText) {
      const x = p1.x + Math.cos(p1.a - Math.PI / 2) * settings.labelDistance;
      const y = p1.y + Math.sin(p1.a - Math.PI / 2) * settings.labelDistance;
      parts.push(`    <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${conn.color}" font-size="${labelSize}" font-family="${fontFamily}">${this.escapeXml(startText)}</text>`);
    }
    if (endText) {
      const x = p2.x + Math.cos(p2.a + Math.PI / 2) * settings.labelDistance;
      const y = p2.y + Math.sin(p2.a + Math.PI / 2) * settings.labelDistance;
      parts.push(`    <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${conn.color}" font-size="${labelSize}" font-family="${fontFamily}">${this.escapeXml(endText)}</text>`);
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Get arrow polygon points.
  //
  private getArrowPoints(x: number, y: number, angle: number, size: number): string {
    // Same triangle as ConnectorView.drawArrow: (-s,-s), (-s,s), (s,0), rotated by angle.
    const c = Math.cos(angle), s = Math.sin(angle);
    return [[-size, -size], [-size, size], [size, 0]]
      .map(([px, py]) => `${x + px * c - py * s},${y + px * s + py * c}`).join(' ');
  }

  //
  // Download the SVG as a file.
  //
  private download(svg: string) {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    let title = this.map.title;
    if (!title) title = "untitled";

    // Use same download mechanism as PNG export
    if ((navigator as any).msSaveBlob) {
      (navigator as any).msSaveBlob(blob, `${title}.svg`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${title}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }
}

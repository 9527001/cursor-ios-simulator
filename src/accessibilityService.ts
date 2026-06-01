import { StreamStartedInfo } from './captureProcess';
import { runSnapshotUi } from './xcodebuildMcpCli';

export interface A11yCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface A11yElement {
  type?: string;
  label?: string;
  name?: string;
  value?: string;
  identifier?: string;
  coordinates?: A11yCoordinates;
}

interface AxSnapshotNode {
  type?: string;
  role?: string;
  role_description?: string;
  title?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  frame?: Partial<A11yCoordinates>;
  AXFrame?: string;
  children?: AxSnapshotNode[];
}

export function parseAxSnapshotOutput(raw: string): AxSnapshotNode[] {
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return parsed as AxSnapshotNode[];
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    if (Array.isArray(obj.children)) {
      return obj.children as AxSnapshotNode[];
    }

    const capture = (obj.data as { capture?: { uiHierarchy?: AxSnapshotNode[] } } | undefined)
      ?.capture;
    if (Array.isArray(capture?.uiHierarchy)) {
      return capture.uiHierarchy;
    }

    const content = (obj.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
    const text = content.find((item) => item?.type === 'text')?.text ?? '';
    if (obj.isError) {
      throw new Error(text || 'snapshot-ui failed');
    }

    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      const inner = JSON.parse(fenced[1]) as unknown;
      if (Array.isArray(inner)) {
        return inner as AxSnapshotNode[];
      }
      if (inner && typeof inner === 'object' && Array.isArray((inner as AxSnapshotNode).children)) {
        return [(inner as AxSnapshotNode)];
      }
    }
  }

  throw new Error('Could not parse xcodebuildmcp snapshot-ui output');
}

export function normalizeAxFrame(raw: unknown): A11yCoordinates | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'object') {
    const frame = raw as Partial<A11yCoordinates> & {
      left?: number;
      top?: number;
      right?: number;
      bottom?: number;
    };
    const x = Number(frame.x ?? frame.left);
    const y = Number(frame.y ?? frame.top);
    const width = Number(frame.width ?? (Number(frame.right) - x));
    const height = Number(frame.height ?? (Number(frame.bottom) - y));
    if ([x, y, width, height].every(Number.isFinite)) {
      return { x, y, width, height };
    }
  }
  if (typeof raw === 'string') {
    const nums = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length >= 4) {
      return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
    }
  }
  return null;
}

function flattenUiHierarchy(tree: AxSnapshotNode[]): A11yElement[] {
  const elements: A11yElement[] = [];

  const visit = (node: AxSnapshotNode): void => {
    const frame = normalizeAxFrame(node.frame ?? node.AXFrame);
    if (frame && frame.width > 0 && frame.height > 0) {
      elements.push({
        type: node.type ?? node.role_description ?? node.role,
        label: node.AXLabel?.trim() || undefined,
        name: node.title?.trim() || undefined,
        value: node.AXValue?.trim() || undefined,
        identifier: node.AXUniqueId?.trim() || undefined,
        coordinates: frame,
      });
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const root of tree) {
    visit(root);
  }

  return elements;
}

export async function listElementsOnScreen(
  deviceUdid: string,
): Promise<{ ok: boolean; elements: A11yElement[]; error?: string }> {
  const snapshot = await runSnapshotUi(deviceUdid);
  if (!snapshot.ok || !snapshot.stdout) {
    return {
      ok: false,
      elements: [],
      error: snapshot.error ?? 'xcodebuildmcp snapshot-ui failed',
    };
  }

  try {
    const tree = parseAxSnapshotOutput(snapshot.stdout);
    return { ok: true, elements: flattenUiHierarchy(tree) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, elements: [], error: message };
  }
}

export function findElementAtPoint(
  elements: A11yElement[],
  normX: number,
  normY: number,
  streamInfo: StreamStartedInfo,
): A11yElement | null {
  const pointX = (normX * streamInfo.pixelWidth) / streamInfo.scale;
  const pointY = (normY * streamInfo.pixelHeight) / streamInfo.scale;

  let best: A11yElement | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const el of elements) {
    const coord = el.coordinates;
    if (!coord || coord.width <= 0 || coord.height <= 0) {
      continue;
    }
    const inside =
      pointX >= coord.x &&
      pointX <= coord.x + coord.width &&
      pointY >= coord.y &&
      pointY <= coord.y + coord.height;
    if (!inside) {
      continue;
    }
    const area = coord.width * coord.height;
    if (area < bestArea) {
      bestArea = area;
      best = el;
    }
  }

  return best;
}

export function elementDisplayName(el: A11yElement): string {
  return (
    el.label?.trim() ||
    el.name?.trim() ||
    el.value?.trim() ||
    el.identifier?.trim() ||
    el.type ||
    'unknown'
  );
}

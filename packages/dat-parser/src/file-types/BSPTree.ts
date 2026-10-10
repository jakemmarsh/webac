import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';

// BSP tree types from ACE BSPType enum
export enum BSPType {
  Drawing = 0,
  Physics = 1,
  Cell = 2,
}

export interface Plane {
  normal: { x: number; y: number; z: number };
  distance: number;
}

export interface Sphere {
  origin: { x: number; y: number; z: number };
  radius: number;
}

export interface PortalPoly {
  portalIndex: number;
  polygonId: number;
}

function readPlane(reader: DatReader): Plane {
  return {
    normal: reader.readVector3(),
    distance: reader.readFloat32(),
  };
}

function readSphere(reader: DatReader): Sphere {
  return {
    origin: reader.readVector3(),
    radius: reader.readFloat32(),
  };
}

// BSP node types
export interface BSPNodeBase {
  type: string;
}

export interface BSPInternalNode extends BSPNodeBase {
  splittingPlane: Plane;
  posNode?: BSPNodeBase;
  negNode?: BSPNodeBase;
  sphere?: Sphere;
  inPolys?: number[];
}

export interface BSPLeafNode extends BSPNodeBase {
  type: 'LEAF';
  leafIndex: number;
  solid?: number;
  sphere?: Sphere;
  inPolys?: number[];
}

export interface BSPPortalNode extends BSPNodeBase {
  type: 'PORT';
  splittingPlane: Plane;
  posNode: BSPNodeBase;
  negNode: BSPNodeBase;
  sphere?: Sphere;
  inPolys?: number[];
  inPortals?: PortalPoly[];
}

function readBSPNodeType(reader: DatReader): string {
  // C# reads 4 bytes then reverses the string: Encoding.ASCII.GetString(reader.ReadBytes(4)).Reverse()
  // Data is stored as little-endian uint32, so bytes are reversed vs the string
  const b0 = reader.readUInt8();
  const b1 = reader.readUInt8();
  const b2 = reader.readUInt8();
  const b3 = reader.readUInt8();
  return String.fromCharCode(b3, b2, b1, b0);
}

export function readBSPNode(reader: DatReader, treeType: BSPType): BSPNodeBase {
  const type = readBSPNodeType(reader);

  if (type === 'LEAF') {
    return readBSPLeaf(reader, treeType);
  }

  if (type === 'PORT') {
    return readBSPPortal(reader, treeType);
  }

  // Internal node (BPnn, BPIn, BpIN, BpnN, BPIN, BPnN)
  const node: BSPInternalNode = {
    type,
    splittingPlane: readPlane(reader),
  };

  switch (type) {
    case 'BPnn':
    case 'BPIn':
      node.posNode = readBSPNode(reader, treeType);
      break;
    case 'BpIN':
    case 'BpnN':
      node.negNode = readBSPNode(reader, treeType);
      break;
    case 'BPIN':
    case 'BPnN':
      node.posNode = readBSPNode(reader, treeType);
      node.negNode = readBSPNode(reader, treeType);
      break;
  }

  if (treeType === BSPType.Cell) return node;

  node.sphere = readSphere(reader);

  if (treeType === BSPType.Physics) return node;

  // Drawing type: read polygon indices
  const numPolys = reader.readUInt32();
  node.inPolys = [];
  for (let i = 0; i < numPolys; i++) {
    node.inPolys.push(reader.readUInt16());
  }

  return node;
}

function readBSPLeaf(reader: DatReader, treeType: BSPType): BSPLeafNode {
  const node: BSPLeafNode = {
    type: 'LEAF',
    leafIndex: reader.readInt32(),
  };

  if (treeType === BSPType.Physics) {
    node.solid = reader.readInt32();
    node.sphere = readSphere(reader);
    const numPolys = reader.readUInt32();
    node.inPolys = [];
    for (let i = 0; i < numPolys; i++) {
      node.inPolys.push(reader.readUInt16());
    }
  }

  return node;
}

function readBSPPortal(reader: DatReader, treeType: BSPType): BSPPortalNode {
  const splittingPlane = readPlane(reader);
  const posNode = readBSPNode(reader, treeType);
  const negNode = readBSPNode(reader, treeType);

  const node: BSPPortalNode = {
    type: 'PORT',
    splittingPlane,
    posNode,
    negNode,
  };

  if (treeType === BSPType.Drawing) {
    node.sphere = readSphere(reader);

    const numPolys = reader.readUInt32();
    const numPortals = reader.readUInt32();

    node.inPolys = [];
    for (let i = 0; i < numPolys; i++) {
      node.inPolys.push(reader.readUInt16());
    }

    node.inPortals = [];
    for (let i = 0; i < numPortals; i++) {
      node.inPortals.push({
        portalIndex: reader.readInt16(),
        polygonId: reader.readInt16(),
      });
    }
  }

  return node;
}

export interface BSPTree {
  rootNode: BSPNodeBase;
}

export function readBSPTree(reader: DatReader, treeType: BSPType): BSPTree {
  return {
    rootNode: readBSPNode(reader, treeType),
  };
}

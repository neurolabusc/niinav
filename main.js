import './style.css'
import { Niivue, SLICE_TYPE, SHOW_RENDER, MULTIPLANAR_TYPE } from '@niivue/niivue'
import { Niimath } from '@niivue/niimath'
import { mat3, vec3 } from 'gl-matrix'

// initially connectome is only fiducials, later we append electrodes
const connectome = {
  name: 'simpleConnectome',
  nodeColormap: 'actc',
  nodeMinColor: 0.01,
  nodeMaxColor: 1,
  edgeMax: 0,
  edgeMin: 1,
  nodes: [
    {
      name: 'Nasion',
      x: 0,
      y: 85,
      z: -40,
      colorValue: 0.75,
      sizeValue: 1
    },
    {
      name: 'TragusL',
      x: -82,
      y: -16,
      z: -35,
      colorValue: 1,
      sizeValue: 1
    },
    {
      name: 'TragusR',
      x: 80,
      y: -6,
      z: -35,
      colorValue: 0.4,
      sizeValue: 1
    },
    {
      name: 'Inion',
      x: 0,
      y: -120,
      z: -30,
      colorValue: 0.3,
      sizeValue: 1
    }
  ],
  edges: []
}

// rel1020 are electrode positions relative to fiducials (nasion, inion, tragus)
// https://github.com/sccn/eeglab/blob/develop/sample_locs/Standard-10-10-Cap33.ced
//polarVec2 are in degrees [theta, phi]
// theta is degrees away from superior vector
// phi is clockwise degrees rotation 0 = anterior, 90 = right, 180 = posterior, 270 = left
const rel1020 = {
  Cz: {
    polarVec2: [0, 0],
    colorValue: 0.02
  },
  C5: {
    polarVec2: [3/5 * 90, 270.0],
    colorValue: 0.1
  },
  T7: {
    polarVec2: [4/5 * 90, 270.0],
    colorValue: 0.2
  },
  CP5: {
    polarVec2: [3/5 * 90, 14/20 * 360],
    colorValue: 0.3
  },
  TP7: {
    polarVec2: [4/5 * 90, 14/20 * 360],
    colorValue: 0.4
  },
  P5: {
    polarVec2: [3/5 * 90, 13/20 * 360],
    colorValue: 0.5
  },
  P7: {
    polarVec2: [4/5 * 90, 13/20 * 360],
    colorValue: 0.6
  },
  Target: {
    polarVec2: [3.5/5 * 90, 13.5/20 * 360],
    colorValue: 0.7
  },
}

// create niivue instance but don't setup the scene just yet
const nv = new Niivue({ backColor: [0.25, 0.25, 0.25, 1], show3Dcrosshair: true })
// create niimath instance (will be initialized later)
const niimath = new Niimath()

async function processImage(cmd = '-mesh -i m -b') {
  loadingCircle.classList.remove('hidden')
  try {
    const imageIndex = 0
    const niiBuffer = await nv.saveImage({ volumeByIndex: imageIndex }).buffer
    const niiFile = new File([niiBuffer], 'image.nii')
    const imageProcessor = niimath.image(niiFile)
    const commands = cmd.split(' ').map((c) => c.trim())
    imageProcessor.commands = [...commands]
    const outName = 'mesh.mz3'
    const processedBlob = await imageProcessor.run(outName) // don't use .gz
    const arrayBuffer = await processedBlob.arrayBuffer()
    await nv.loadFromArrayBuffer(arrayBuffer, outName)
    nv.setMeshProperty(nv.meshes[1].id, 'visible', false)
    loadingCircle.classList.add('hidden')
  } catch (error) {
    loadingCircle.classList.add('hidden')
    console.error(error)
  }
}

async function loadImage(url) {
  // remove all meshes and volumes
  for (let i = 0; i < nv.meshes.length; i++) {
    nv.removeMesh(nv.meshes[i])
  }
  for (let i = 0; i < nv.volumes.length; i++) {
    nv.removeVolume(nv.volumes[i])
  }
  const volumeList = [{ url }]
  await nv.loadVolumes(volumeList)
  nv.updateGLVolume()
}

function createWorldSpaceMatrix(vtxA, vtxL, vtxR, vtxP) {
  // input: vertices for nasion (anterior), tragusL (left), tragusR (right), inion (posterior)
  // outputs matrix3x3 for workd space
  function computeNormal(v0, v1, v2) {
    // input: three vertices define triangle
    // output: surface normal
    const edge1 = vec3.create()
    const edge2 = vec3.create()
    vec3.subtract(edge1, v1, v0) // edge1 = v1 - v0
    vec3.subtract(edge2, v2, v0) // edge2 = v2 - v0
    // Compute the cross product of the two edges (gives the normal)
    const normal = vec3.create()
    vec3.cross(normal, edge1, edge2)
    // Normalize the resulting normal vector
    vec3.normalize(normal, normal)
    // Ensure the z-component is positive
    if (normal[2] < 0) {
      vec3.scale(normal, normal, -1) // Flip the vector if z is negative
    }
    return normal
  } // computeNormal
  // we have 4 landmarks for estimating Cz position
  // these may not be co-planar, so we will use the average normal and centroid
  const norms = []
  norms.push(computeNormal(vtxA, vtxL, vtxP)) // nasion, tragusL, inion
  norms.push(computeNormal(vtxA, vtxR, vtxP)) // nasion, tragusR, inion
  function averageNormals(normals) {
    const avgNormal = vec3.create()
    normals.forEach((normal) => {
      vec3.add(avgNormal, avgNormal, normal)
    })
    vec3.normalize(avgNormal, avgNormal)
    return avgNormal
  }
  function worldSpaceMatrix(vtxA, vtxP, vecZ) {
    // n.b. the L/R tragus might not be orthogonal to A/P inion-nasion
    // therefore, we set vecX as cross product to enforce a orhonormal solution
    // vecY is vector pointing posterior->anterior
    const vecY = vec3.create()
    vec3.subtract(vecY, vtxA, vtxP) // edge1 = v1 - v0
    vec3.normalize(vecY, vecY)
    const vecX = vec3.create()
    //
    vec3.cross(vecX, vecY, vecZ)
    vec3.normalize(vecX, vecX)
    // Create a 3x3 matrix and set vecX, vecY, and vecZ as columns
    const matrix = mat3.fromValues(vecX[0], vecX[1], vecX[2], vecY[0], vecY[1], vecY[2], vecZ[0], vecZ[1], vecZ[2])
    return matrix
  }
  return worldSpaceMatrix(vtxA, vtxP, averageNormals(norms))
}

function polarTo3D(polarVec2, worldMat33) {
  const [theta, phi] = polarVec2
  // Convert theta and phi from degrees to radians
  const thetaRad = (theta * Math.PI) / 180
  const phiRad = ((90 - phi) * Math.PI) / 180
  // Calculate Cartesian coordinates
  const x = Math.sin(thetaRad) * Math.cos(phiRad)
  const y = Math.sin(thetaRad) * Math.sin(phiRad)
  const z = Math.cos(thetaRad)
  const result = vec3.fromValues(x, y, z)
  vec3.transformMat3(result, result, worldMat33)
  return result
}

function computeCentroid(vectors) {
  // input: array of vertices
  // output: vertex of mean position
  const centroid = vec3.create()
  vectors.forEach((vec) => {
    vec3.add(centroid, centroid, vec)
  })
  if (vectors.length > 0) {
    vec3.scale(centroid, centroid, 1 / vectors.length)
  }
  return centroid
}

function closestDistanceToLine(point, origin, direction) {
  // Create a vector from the line's origin to the point
  const op = vec3.create()
  vec3.subtract(op, point, origin) // OP = point - origin
  // Check if the point is in the same direction as the line
  const dotProduct = vec3.dot(op, direction)
  // If the dot product is negative, return infinity (point is in the opposite direction)
  if (dotProduct < 0) {
    return Infinity
  }
  // Compute the cross product of OP and the line's direction vector
  const crossProduct = vec3.create()
  vec3.cross(crossProduct, op, direction)
  // Compute the magnitude of the cross product (|OP x v|)
  const crossMagnitude = vec3.length(crossProduct)
  // Compute the magnitude of the direction vector (|v|)
  const directionMagnitude = vec3.length(direction)
  // The distance is the magnitude of the cross product divided by the magnitude of the direction vector
  const distance = crossMagnitude / directionMagnitude
  return distance
}

async function positionElectrodes() {
  // vecs is vertices for nasion, tragusL, tragusR, inion
  if (connectome.nodes.length < 4) {
    throw new Error('connectome must have at least 4 vertices (nasion, tragusL, tragusR, inion)')
  }
  const vtxA = vec3.fromValues(connectome.nodes[0].x, connectome.nodes[0].y, connectome.nodes[0].z)
  const vtxL = vec3.fromValues(connectome.nodes[1].x, connectome.nodes[1].y, connectome.nodes[1].z)
  const vtxR = vec3.fromValues(connectome.nodes[2].x, connectome.nodes[2].y, connectome.nodes[2].z)
  const vtxP = vec3.fromValues(connectome.nodes[3].x, connectome.nodes[3].y, connectome.nodes[3].z)
  const worldMat33 = createWorldSpaceMatrix(vtxA, vtxL, vtxR, vtxP)
  // find centroid for origin of vector toward Cz
  const centroid = computeCentroid([vtxA, vtxL, vtxR, vtxP])
  // now find the scalp vertex closest to the line
  for (const key in rel1020) {
    if (!rel1020[key].polarVec2) {
      console.log(`${key}: No polarVec2`)
      continue
    }
    let nearestMM = Infinity
    let nearestVtx = vec3.fromValues(0, 0, 0)
    const polarVec3 = polarTo3D(rel1020[key].polarVec2, worldMat33)
    const pts = nv.meshes[1].pts
    for (let i = 0; i < pts.length; i += 3) {
      const vtx = vec3.fromValues(pts[i], pts[i + 1], pts[i + 2])
      const dx = closestDistanceToLine(vtx, centroid, polarVec3)
      if (dx < nearestMM) {
        // start optional: require minimum distance from centroid, adult skull min radius ~70mm
        // rationale: ignore ear canals
        const minOriginDx = 70
        let originDx = vec3.distance(vtx, centroid)
        if (originDx < minOriginDx) {
          continue
        }
        //end optional
        nearestMM = dx
        nearestVtx = vtx
      }
    }
    if (!isFinite(nearestMM)) {
      return
    }
    nv.meshes[0].addConnectomeNode({
      name: key,
      x: nearestVtx[0],
      y: nearestVtx[1],
      z: nearestVtx[2],
      colorValue: rel1020[key].colorValue,
      sizeValue: 1
    })
  }
  nv.meshes[0].updateMesh(nv.gl)
  nv.drawScene()
}

async function main() {
  const nFiducials = 4
  function initializeImageProcessing() {
    meshLevel.disabled = false
  }
  saveButton.onclick = function () {
    nv.saveDocument("custom.nvd")
  }
  aboutButton.onclick = function () {
    const link = 'https://github.com/rordenlab/niimath?tab=readme-ov-file#about'
    window.open(link, '_blank')
  }
  clipCheck.onchange = function () {
    if (clipCheck.checked) {
      nv.setClipPlane([0, 0, 90])
    } else {
      nv.setClipPlane([2, 0, 90])
    }
  }
  meshLevel.onchange = async function () {
    if (meshLevel.selectedIndex > 1) {
      return //do nothing
    }
    while (nv.meshes.length > 1) {
      await nv.removeMesh(nv.meshes[1])
    }
    while (nv.meshes[0].nodes.length > nFiducials) {
      nv.meshes[0].deleteConnectomeNode(nv.meshes[0].nodes[nFiducials])
    }
    if (meshLevel.selectedIndex < 1) {
      nv.drawScene()
      return
    }
    const cmd = '-s 1 -mesh -i d -b 1 -l 1'
    await processImage(cmd)
    positionElectrodes()
  }
  const canvas = document.getElementById('gl')
  nv.setInterpolation(true)
  nv.attachToCanvas(canvas)
  nv.isAlphaClipDark = true
  nv.onLocationChange = handleIntensityChange
  nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
  nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID)
  nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS
  const volumeList = [{ url: './T1.nii.gz' }]
  await nv.loadVolumes(volumeList)
  nv.loadConnectome(connectome)
  let lastPos = null
  gl.ondblclick = async function () {
    if (meshLevel.selectedIndex > 1) {
      return //do nothing
    }
    if (!lastPos) {
      return
    }
    if (!lastPos.values) {
      return
    }
    // assume user is moving target position
    let mnI = connectome.nodes.length - 1
    let mxI = mnI
    //alternatively, move fiducials
    if (meshLevel.selectedIndex < 1) {
      mnI = 0
      mxI = nFiducials - 1
    }
    let nearestMM = Infinity
    let nearestIdx = 0
    for (let i = mnI; i <= mxI; i++) {
      const n = connectome.nodes[i]
      const dx = Math.sqrt((n.x - lastPos.mm[0]) ** 2 + (n.y - lastPos.mm[1]) ** 2 + (n.z - lastPos.mm[2]) ** 2)
      if (dx < nearestMM) {
        nearestIdx = i
        nearestMM = dx
      }
    }
    // tolerance: ignore clicks more than 75mm from node
    const tolMM = 75
    if (nearestMM > tolMM) {
      return
    }
    connectome.nodes[nearestIdx].x = lastPos.mm[0]
    connectome.nodes[nearestIdx].y = lastPos.mm[1]
    connectome.nodes[nearestIdx].z = lastPos.mm[2]
    nv.loadConnectome(connectome)
    clipCheck.onchange()
  }
  function handleIntensityChange(data) {
    intensity.innerHTML = '&nbsp;&nbsp;' + data.string
    lastPos = data
  }
  // initialize niimath (loads wasm and sets up worker)
  await niimath.init()
  // enable our button after our WASM has been setup
  initializeImageProcessing()
  nv.onImageLoaded = (volume) => {
    nv.loadConnectome(connectome)
    meshLevel.selectedIndex = 0
    meshLevel.onchange()
  }
  //meshLevel.selectedIndex = 1
  //meshLevel.onchange()
}

main()

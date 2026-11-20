/**
 * ae-api.d.ts — GENERATED from inventories/scripting/generated/symbols.json.
 * Regenerate: node packages/ae-devtools-cli/jsx-toolchain/src/gen-ae-types.mjs
 *
 * HONEST SCOPE: the inventory records symbol NAMES, kinds and access
 * but almost no signatures. Every member is `any`-typed; methods take
 * `...args: any[]`. This file catches typos and gives discovery — it
 * does NOT check argument types or return shapes. Every inventory
 * class is an `interface` plus — only where the host really supports
 * `instanceof` — a structural `declare const` value side. The
 * inventory's `instanceofCaveat` marks classes whose `instanceof`
 * throws or always returns false (AVItem, Collection, FootageSource,
 * Item, Layer, PropertyBase): those get NO value side, so
 * `x instanceof Item` is a type error instead of a narrowing promise
 * the host cannot keep. `baseOnly` abstract bases get a CALL
 * signature (no construct signature): `instanceof` typechecks and
 * narrows, `new X()` does not. Other classes get a construct
 * signature, so `new X(...)` typechecks — an over-approximation,
 * since the inventory has no signature data (arity and
 * constructibility are not checked). The `app`/`system` globals are
 * declared once in ae-globals.d.ts; this file provides only the
 * `AeAppApi`/`System` types.
 * ExtendScript builtins ($, File, Folder, BridgeTalk, Socket, XML,
 * JSON-if-present) are NOT covered here; see ae-globals.d.ts for the
 * hand-maintained extras.
 */

interface AVItem {
  duration: any;
  footageMissing: any;
  frameDuration: any;
  frameRate: any;
  hasAudio: any;
  hasVideo: any;
  height: any;
  isMediaReplacementCompatible: any;
  name: any;
  pixelAspect: any;
  proxySource: any;
  setProxy(...args: any[]): any;
  setProxyToNone(...args: any[]): any;
  setProxyWithPlaceholder(...args: any[]): any;
  setProxyWithSequence(...args: any[]): any;
  setProxyWithSolid(...args: any[]): any;
  time: any;
  usedIn: any;
  useProxy: any;
  width: any;
}

interface CharacterRange {
  characterEnd: any;
  characterStart: any;
  fillColor: any;
  isRangeValid: any;
  kerning: any;
  pasteFrom(...args: any[]): any;
  strokeColor: any;
  strokeOverFill: any;
  text: any;
  toString(...args: any[]): any;
}

declare const CharacterRange: { prototype: CharacterRange; new (...args: any[]): CharacterRange };

interface Collection {
}

interface ComposedLineRange {
  characterEnd: any;
  characterRange(...args: any[]): any;
  characterStart: any;
  isRangeValid: any;
  toString(...args: any[]): any;
}

declare const ComposedLineRange: { prototype: ComposedLineRange; new (...args: any[]): ComposedLineRange };

interface FolderItem {
  item(...args: any[]): any;
  items: any;
  numItems: any;
}

declare const FolderItem: { prototype: FolderItem; new (...args: any[]): FolderItem };

interface FontObject {
  designAxesData: any;
  designVector: any;
  familyName: any;
  familyPrefix: any;
  fontID: any;
  fullName: any;
  hasDesignAxes: any;
  hasGlyphsFor(...args: any[]): any;
  hasSameDict(...args: any[]): any;
  isFromAdobeFonts: any;
  isSubstitute: any;
  location: any;
  nativeFamilyName: any;
  nativeFullName: any;
  nativeStyleName: any;
  otherFontsWithSameDict: any;
  postScriptName: any;
  postScriptNameForDesignVector(...args: any[]): any;
  styleName: any;
  technology: any;
  type: any;
  version: any;
  writingScripts: any;
}

declare const FontObject: { prototype: FontObject; new (...args: any[]): FontObject };

interface FontsObject {
  allFonts: any;
  favoriteFontFamilyList: any;
  fontsDuplicateByPostScriptName: any;
  fontServerRevision: any;
  fontsWithDefaultDesignAxes: any;
  freezeSyncSubstitutedFonts: any;
  getCTScriptForString(...args: any[]): any;
  getDefaultFontForCTScript(...args: any[]): any;
  getFontByID(...args: any[]): any;
  getFontsByFamilyNameAndStyleName(...args: any[]): any;
  getFontsByPostScriptName(...args: any[]): any;
  missingOrSubstitutedFonts: any;
  mruFontFamilyList: any;
  pollForAndPushNonSystemFontFoldersChanges(...args: any[]): any;
  setDefaultFontForCTScript(...args: any[]): any;
  substitutedFontReplacementMatchPolicy: any;
}

declare const FontsObject: { prototype: FontsObject; new (...args: any[]): FontsObject };

interface FootageSource {
  alphaMode: any;
  conformFrameRate: any;
  displayFrameRate: any;
  fieldSeparationType: any;
  guessAlphaMode(...args: any[]): any;
  guessPulldown(...args: any[]): any;
  hasAlpha: any;
  highQualityFieldSeparation: any;
  invertAlpha: any;
  isStill: any;
  loop: any;
  nativeFrameRate: any;
  premulColor: any;
  removePulldown: any;
}

interface GuideOptions {
  color: any;
  orientation: any;
  pinned: any;
  position: any;
  positionType: any;
}

declare const GuideOptions: { prototype: GuideOptions; new (...args: any[]): GuideOptions };

interface ImportOptions {
  canImportAs(...args: any[]): any;
  file: any;
  forceAlphabetical: any;
  importAs: any;
  isFileNameNumbered(...args: any[]): any;
  rangeEnd: any;
  rangeStart: any;
  sequence: any;
}

declare const ImportOptions: { prototype: ImportOptions; new (...args: any[]): ImportOptions };

interface Item {
  addGuide(...args: any[]): any;
  comment: any;
  dynamicLinkGUID: any;
  getGuideAsObject(...args: any[]): any;
  guides: any;
  id: any;
  label: any;
  name: any;
  parentFolder: any;
  remove(...args: any[]): any;
  removeGuide(...args: any[]): any;
  selected: any;
  setGuide(...args: any[]): any;
  typeName: any;
}

interface KeyframeEase {
  influence: any;
  speed: any;
}

declare const KeyframeEase: { prototype: KeyframeEase; new (...args: any[]): KeyframeEase };

interface MarkerValue {
  chapter: any;
  comment: any;
  cuePointName: any;
  duration: any;
  eventCuePoint: any;
  frameTarget: any;
  getParameters(...args: any[]): any;
  label: any;
  protectedRegion: any;
  setParameters(...args: any[]): any;
  url: any;
}

declare const MarkerValue: { prototype: MarkerValue; new (...args: any[]): MarkerValue };

interface OutputModule {
  applyTemplate(...args: any[]): any;
  file: any;
  getSetting(...args: any[]): any;
  getSettings(...args: any[]): any;
  includeSourceXMP: any;
  name: any;
  postRenderAction: any;
  remove(...args: any[]): any;
  saveAsTemplate(...args: any[]): any;
  setSetting(...args: any[]): any;
  setSettings(...args: any[]): any;
  templates: any;
}

declare const OutputModule: { prototype: OutputModule; new (...args: any[]): OutputModule };

interface ParagraphRange {
  characterEnd: any;
  characterRange(...args: any[]): any;
  characterStart: any;
  isRangeValid: any;
  toString(...args: any[]): any;
}

declare const ParagraphRange: { prototype: ParagraphRange; new (...args: any[]): ParagraphRange };

interface Preferences {
  deletePref(...args: any[]): any;
  getPrefAsBool(...args: any[]): any;
  getPrefAsFloat(...args: any[]): any;
  getPrefAsLong(...args: any[]): any;
  getPrefAsString(...args: any[]): any;
  havePref(...args: any[]): any;
  reload(...args: any[]): any;
  savePrefAsBool(...args: any[]): any;
  savePrefAsFloat(...args: any[]): any;
  savePrefAsLong(...args: any[]): any;
  savePrefAsString(...args: any[]): any;
  saveToDisk(...args: any[]): any;
}

declare const Preferences: { prototype: Preferences; new (...args: any[]): Preferences };

interface Project {
  activeItem: any;
  autoFixExpressions(...args: any[]): any;
  bitsPerChannel: any;
  close(...args: any[]): any;
  closeTeamProject(...args: any[]): any;
  compensateForSceneReferredProfiles: any;
  consolidateFootage(...args: any[]): any;
  convertTeamProjectToProject(...args: any[]): any;
  dirty: any;
  displayStartFrame: any;
  expressionEngine: any;
  feetFramesFilmType: any;
  file: any;
  footageTimecodeDisplayStartType: any;
  framesCountType: any;
  framesUseFeetFrames: any;
  gpuAccelType: any;
  importFile(...args: any[]): any;
  importFileWithDialog(...args: any[]): any;
  importPlaceholder(...args: any[]): any;
  isAnyTeamProjectOpen(...args: any[]): any;
  isLoggedInToTeamProject(...args: any[]): any;
  isResolveCommandEnabled(...args: any[]): any;
  isShareCommandEnabled(...args: any[]): any;
  isSyncCommandEnabled(...args: any[]): any;
  isTeamProjectEnabled(...args: any[]): any;
  isTeamProjectOpen(...args: any[]): any;
  item(...args: any[]): any;
  itemByID(...args: any[]): any;
  items: any;
  layerByID(...args: any[]): any;
  linearBlending: any;
  linearizeWorkingSpace: any;
  listColorProfiles(...args: any[]): any;
  listTeamProjects(...args: any[]): any;
  newTeamProject(...args: any[]): any;
  numItems: any;
  openTeamProject(...args: any[]): any;
  reduceProject(...args: any[]): any;
  removeUnusedFootage(...args: any[]): any;
  renderQueue: any;
  replaceFont(...args: any[]): any;
  resolveConflict(...args: any[]): any;
  revision: any;
  rootFolder: any;
  save(...args: any[]): any;
  saveWithDialog(...args: any[]): any;
  selection: any;
  setDefaultImportFolder(...args: any[]): any;
  shareTeamProject(...args: any[]): any;
  showWindow(...args: any[]): any;
  syncTeamProject(...args: any[]): any;
  timeDisplayType: any;
  toolType: any;
  transparencyGridThumbnails: any;
  usedFonts: any;
  workingGamma: any;
  workingSpace: any;
  xmpPacket: any;
}

declare const Project: { prototype: Project; new (...args: any[]): Project };

interface PropertyBase {
  active: any;
  canSetEnabled: any;
  duplicate(...args: any[]): any;
  elided: any;
  enabled: any;
  isEffect: any;
  isMask: any;
  isModified: any;
  matchName: any;
  moveTo(...args: any[]): any;
  name: any;
  parentProperty: any;
  propertyDepth: any;
  propertyGroup(...args: any[]): any;
  propertyIndex: any;
  propertyType: any;
  remove(...args: any[]): any;
  selected: any;
}

interface RenderQueue {
  canQueueInAME: any;
  item(...args: any[]): any;
  items: any;
  numItems: any;
  pauseRendering(...args: any[]): any;
  queueInAME(...args: any[]): any;
  queueNotify: any;
  render(...args: any[]): any;
  rendering: any;
  showWindow(...args: any[]): any;
  stopRendering(...args: any[]): any;
}

declare const RenderQueue: { prototype: RenderQueue; new (...args: any[]): RenderQueue };

interface RenderQueueItem {
  applyTemplate(...args: any[]): any;
  comp: any;
  duplicate(...args: any[]): any;
  elapsedSeconds: any;
  getSetting(...args: any[]): any;
  getSettings(...args: any[]): any;
  logType: any;
  numOutputModules: any;
  onStatusChanged: any;
  outputModule(...args: any[]): any;
  outputModules: any;
  queueItemNotify: any;
  remove(...args: any[]): any;
  render: any;
  saveAsTemplate(...args: any[]): any;
  setSetting(...args: any[]): any;
  setSettings(...args: any[]): any;
  skipFrames: any;
  startTime: any;
  status: any;
  templates: any;
  timeSpanDuration: any;
  timeSpanStart: any;
}

declare const RenderQueueItem: { prototype: RenderQueueItem; new (...args: any[]): RenderQueueItem };

interface Settings {
  getSetting(...args: any[]): any;
  haveSetting(...args: any[]): any;
  saveSetting(...args: any[]): any;
}

declare const Settings: { prototype: Settings; new (...args: any[]): Settings };

interface Shape {
  closed: any;
  featherInterps: any;
  featherRadii: any;
  featherRelCornerAngles: any;
  featherRelSegLocs: any;
  featherSegLocs: any;
  featherTensions: any;
  featherTypes: any;
  inTangents: any;
  outTangents: any;
  vertices: any;
}

declare const Shape: { prototype: Shape; new (...args: any[]): Shape };

interface System {
  callSystem(...args: any[]): any;
  machineName: any;
  osName: any;
  osVersion: any;
  userName: any;
}

declare const System: { prototype: System; new (...args: any[]): System };

interface TextDocument {
  allCaps: any;
  applyFill: any;
  applyStroke: any;
  autoHyphenate: any;
  autoKernType: any;
  autoLeading: any;
  baselineDirection: any;
  baselineLocs: any;
  baselineShift: any;
  boxAutoFitPolicy: any;
  boxFirstBaselineAlignment: any;
  boxFirstBaselineAlignmentMinimum: any;
  boxInsetSpacing: any;
  boxOverflow: any;
  boxText: any;
  boxTextPos: any;
  boxTextSize: any;
  boxVerticalAlignment: any;
  characterRange(...args: any[]): any;
  composedLineCharacterIndexesAt(...args: any[]): any;
  composedLineCount: any;
  composedLineRange(...args: any[]): any;
  composerEngine: any;
  digitSet: any;
  direction: any;
  endIndent: any;
  everyLineComposer: any;
  fauxBold: any;
  fauxItalic: any;
  fillColor: any;
  firstLineIndent: any;
  font: any;
  fontBaselineOption: any;
  fontCapsOption: any;
  fontFamily: any;
  fontLocation: any;
  fontObject: any;
  fontSize: any;
  fontStyle: any;
  hangingRoman: any;
  horizontalScale: any;
  justification: any;
  kerning: any;
  leading: any;
  leadingType: any;
  ligature: any;
  lineJoinType: any;
  lineOrientation: any;
  noBreak: any;
  paragraphCharacterIndexesAt(...args: any[]): any;
  paragraphCount: any;
  paragraphRange(...args: any[]): any;
  pointText: any;
  resetCharStyle(...args: any[]): any;
  resetParagraphStyle(...args: any[]): any;
  smallCaps: any;
  spaceAfter: any;
  spaceBefore: any;
  startIndent: any;
  strokeColor: any;
  strokeOverFill: any;
  strokeWidth: any;
  subscript: any;
  superscript: any;
  text: any;
  tracking: any;
  tsume: any;
  verticalScale: any;
}

declare const TextDocument: { prototype: TextDocument; new (...args: any[]): TextDocument };

interface View {
  active: any;
  options: any;
  setActive(...args: any[]): any;
}

declare const View: { prototype: View; new (...args: any[]): View };

interface Viewer {
  active: any;
  activeViewIndex: any;
  maximized: any;
  setActive(...args: any[]): any;
  type: any;
  views: any;
}

declare const Viewer: { prototype: Viewer; new (...args: any[]): Viewer };

interface ViewOptions {
  channels: any;
  checkerboards: any;
  exposure: any;
  fastPreview: any;
  guidesLocked: any;
  guidesSnap: any;
  guidesVisibility: any;
  rulers: any;
  zoom: any;
}

declare const ViewOptions: { prototype: ViewOptions; new (...args: any[]): ViewOptions };

interface AVLayer extends Layer {
  addToMotionGraphicsTemplate(...args: any[]): any;
  addToMotionGraphicsTemplateAs(...args: any[]): any;
  adjustmentLayer: any;
  audioActive: any;
  audioActiveAtTime(...args: any[]): any;
  audioEnabled: any;
  blendingMode: any;
  calculateTransformFromPoints(...args: any[]): any;
  canAddToMotionGraphicsTemplate(...args: any[]): any;
  canSetCollapseTransformation: any;
  canSetTimeRemapEnabled: any;
  collapseTransformation: any;
  compPointToSource(...args: any[]): any;
  effectsActive: any;
  environmentLayer: any;
  frameBlending: any;
  frameBlendingType: any;
  guideLayer: any;
  hasAudio: any;
  hasTrackMatte: any;
  height: any;
  isNameFromSource: any;
  isTrackMatte: any;
  motionBlur: any;
  openInViewer(...args: any[]): any;
  preserveTransparency: any;
  quality: any;
  removeTrackMatte(...args: any[]): any;
  replaceSource(...args: any[]): any;
  samplingQuality: any;
  setTrackMatte(...args: any[]): any;
  source: any;
  sourcePointToComp(...args: any[]): any;
  sourceRectAtTime(...args: any[]): any;
  threeDLayer: any;
  threeDPerChar: any;
  timeRemapEnabled: any;
  trackMatteLayer: any;
  trackMatteType: any;
  width: any;
}

declare const AVLayer: { prototype: AVLayer; (...args: any[]): AVLayer };

interface CameraLayer extends Layer {
}

declare const CameraLayer: { prototype: CameraLayer; new (...args: any[]): CameraLayer };

interface CompItem extends AVItem {
  activeCamera: any;
  bgColor: any;
  counters: any;
  displayStartFrame: any;
  displayStartTime: any;
  draft3d: any;
  dropFrame: any;
  duplicate(...args: any[]): any;
  exportAsMotionGraphicsTemplate(...args: any[]): any;
  frameBlending: any;
  frameDuration: any;
  getMotionGraphicsTemplateControllerName(...args: any[]): any;
  hideShyLayers: any;
  layer(...args: any[]): any;
  layers: any;
  markerProperty: any;
  motionBlur: any;
  motionBlurAdaptiveSampleLimit: any;
  motionBlurSamplesPerFrame: any;
  motionGraphicsTemplateControllerCount: any;
  motionGraphicsTemplateName: any;
  numLayers: any;
  openInEssentialGraphics(...args: any[]): any;
  openInViewer(...args: any[]): any;
  preserveNestedFrameRate: any;
  preserveNestedResolution: any;
  renderer: any;
  renderers: any;
  resolutionFactor: any;
  selectedLayers: any;
  selectedProperties: any;
  setMotionGraphicsControllerName(...args: any[]): any;
  shutterAngle: any;
  shutterPhase: any;
  workAreaDuration: any;
  workAreaStart: any;
}

declare const CompItem: { prototype: CompItem; new (...args: any[]): CompItem };

interface FileSource extends FootageSource {
  file: any;
  missingFootagePath: any;
  reload(...args: any[]): any;
}

declare const FileSource: { prototype: FileSource; new (...args: any[]): FileSource };

interface FootageItem extends AVItem {
  file: any;
  mainSource: any;
  openInViewer(...args: any[]): any;
  replace(...args: any[]): any;
  replaceWithPlaceholder(...args: any[]): any;
  replaceWithSequence(...args: any[]): any;
  replaceWithSolid(...args: any[]): any;
}

declare const FootageItem: { prototype: FootageItem; new (...args: any[]): FootageItem };

interface ItemCollection extends Collection {
  addComp(...args: any[]): any;
  addFolder(...args: any[]): any;
}

declare const ItemCollection: { prototype: ItemCollection; new (...args: any[]): ItemCollection };

interface Layer extends PropertyGroup {
  activeAtTime(...args: any[]): any;
  addGuide(...args: any[]): any;
  applyPreset(...args: any[]): any;
  autoOrient: any;
  comment: any;
  containingComp: any;
  copyToComp(...args: any[]): any;
  doSceneEditDetection(...args: any[]): any;
  duplicate(...args: any[]): any;
  getGuideAsObject(...args: any[]): any;
  guides: any;
  hasVideo: any;
  id: any;
  index: any;
  inPoint: any;
  isNameSet: any;
  label: any;
  locked: any;
  marker: any;
  moveAfter(...args: any[]): any;
  moveBefore(...args: any[]): any;
  moveToBeginning(...args: any[]): any;
  moveToEnd(...args: any[]): any;
  nullLayer: any;
  outPoint: any;
  parent: any;
  remove(...args: any[]): any;
  removeGuide(...args: any[]): any;
  selectedProperties: any;
  setGuide(...args: any[]): any;
  setParentWithJump(...args: any[]): any;
  shy: any;
  solo: any;
  startTime: any;
  stretch: any;
  time: any;
}

interface LayerCollection extends Collection {
  add(...args: any[]): any;
  addBoxText(...args: any[]): any;
  addCamera(...args: any[]): any;
  addLight(...args: any[]): any;
  addNull(...args: any[]): any;
  addParametricMesh(...args: any[]): any;
  addShape(...args: any[]): any;
  addSolid(...args: any[]): any;
  addText(...args: any[]): any;
  addVerticalBoxText(...args: any[]): any;
  addVerticalText(...args: any[]): any;
  byName(...args: any[]): any;
  precompose(...args: any[]): any;
}

declare const LayerCollection: { prototype: LayerCollection; new (...args: any[]): LayerCollection };

interface LightLayer extends Layer {
  lightSource: any;
  lightType: any;
}

declare const LightLayer: { prototype: LightLayer; new (...args: any[]): LightLayer };

interface MaskPropertyGroup extends PropertyGroup {
  color: any;
  inverted: any;
  locked: any;
  maskFeatherFalloff: any;
  maskMode: any;
  maskMotionBlur: any;
  rotoBezier: any;
}

declare const MaskPropertyGroup: { prototype: MaskPropertyGroup; new (...args: any[]): MaskPropertyGroup };

interface OMCollection extends Collection {
  add(...args: any[]): any;
}

declare const OMCollection: { prototype: OMCollection; new (...args: any[]): OMCollection };

interface ParametricMeshLayer extends AVLayer {
  parametricBevelOptions: any;
  parametricMeshOptions: any;
  parametricMeshType: any;
}

declare const ParametricMeshLayer: { prototype: ParametricMeshLayer; new (...args: any[]): ParametricMeshLayer };

interface PlaceholderSource extends FootageSource {
}

declare const PlaceholderSource: { prototype: PlaceholderSource; new (...args: any[]): PlaceholderSource };

interface Property extends PropertyBase {
  addKey(...args: any[]): any;
  addToMotionGraphicsTemplate(...args: any[]): any;
  addToMotionGraphicsTemplateAs(...args: any[]): any;
  alternateSource: any;
  canAddToMotionGraphicsTemplate(...args: any[]): any;
  canSetAlternateSource: any;
  canSetExpression: any;
  canVaryOverTime: any;
  dimensionsSeparated: any;
  essentialPropertySource: any;
  expression: any;
  expressionEnabled: any;
  expressionError: any;
  getInputStageCycleSafeLimit(...args: any[]): any;
  getSeparationFollower(...args: any[]): any;
  hasMax: any;
  hasMin: any;
  inputLayerAndStage: any;
  isDropdownEffect: any;
  isInterpolationTypeValid(...args: any[]): any;
  isSeparationFollower: any;
  isSeparationLeader: any;
  isSpatial: any;
  isTimeVarying: any;
  keyInInterpolationType(...args: any[]): any;
  keyInSpatialTangent(...args: any[]): any;
  keyInTemporalEase(...args: any[]): any;
  keyLabel(...args: any[]): any;
  keyOutInterpolationType(...args: any[]): any;
  keyOutSpatialTangent(...args: any[]): any;
  keyOutTemporalEase(...args: any[]): any;
  keyRoving(...args: any[]): any;
  keySelected(...args: any[]): any;
  keySpatialAutoBezier(...args: any[]): any;
  keySpatialContinuous(...args: any[]): any;
  keyTemporalAutoBezier(...args: any[]): any;
  keyTemporalContinuous(...args: any[]): any;
  keyTime(...args: any[]): any;
  keyValue(...args: any[]): any;
  layerInputStage: any;
  LayerInputStageType: any;
  maxValue: any;
  minValue: any;
  nearestKeyIndex(...args: any[]): any;
  numKeys: any;
  propertyIndex: any;
  propertyParameters: any;
  propertyValueType: any;
  removeKey(...args: any[]): any;
  selectedKeys: any;
  separationDimension: any;
  separationLeader: any;
  setAlternateSource(...args: any[]): any;
  setInputLayerAndStage(...args: any[]): any;
  setInterpolationTypeAtKey(...args: any[]): any;
  setLabelAtKey(...args: any[]): any;
  setLayerInputStage(...args: any[]): any;
  setPropertyParameters(...args: any[]): any;
  setRovingAtKey(...args: any[]): any;
  setSelectedAtKey(...args: any[]): any;
  setSpatialAutoBezierAtKey(...args: any[]): any;
  setSpatialContinuousAtKey(...args: any[]): any;
  setSpatialTangentsAtKey(...args: any[]): any;
  setTemporalAutoBezierAtKey(...args: any[]): any;
  setTemporalContinuousAtKey(...args: any[]): any;
  setTemporalEaseAtKey(...args: any[]): any;
  setValue(...args: any[]): any;
  setValueAtKey(...args: any[]): any;
  setValueAtTime(...args: any[]): any;
  setValuesAtTimes(...args: any[]): any;
  unitsText: any;
  value: any;
  valueAtTime(...args: any[]): any;
  valueText: any;
}

declare const Property: { prototype: Property; new (...args: any[]): Property };

interface PropertyGroup extends PropertyBase {
  addProperty(...args: any[]): any;
  addVariableFontAxis(...args: any[]): any;
  canAddProperty(...args: any[]): any;
  numProperties: any;
  property(...args: any[]): any;
}

declare const PropertyGroup: { prototype: PropertyGroup; (...args: any[]): PropertyGroup };

interface RQItemCollection extends Collection {
  add(...args: any[]): any;
}

declare const RQItemCollection: { prototype: RQItemCollection; new (...args: any[]): RQItemCollection };

interface ShapeLayer extends AVLayer {
}

declare const ShapeLayer: { prototype: ShapeLayer; new (...args: any[]): ShapeLayer };

interface SolidSource extends FootageSource {
  color: any;
}

declare const SolidSource: { prototype: SolidSource; new (...args: any[]): SolidSource };

interface TextLayer extends AVLayer {
}

declare const TextLayer: { prototype: TextLayer; new (...args: any[]): TextLayer };

interface ThreeDModelLayer extends AVLayer {
}

declare const ThreeDModelLayer: { prototype: ThreeDModelLayer; new (...args: any[]): ThreeDModelLayer };

interface AeAppApi {
  activate(...args: any[]): any;
  activeViewer: any;
  availableGPUAccelTypes: any;
  beginSuppressDialogs(...args: any[]): any;
  beginUndoGroup(...args: any[]): any;
  buildName: any;
  buildNumber: any;
  cancelTask(...args: any[]): any;
  disableRendering: any;
  effects: any;
  endSuppressDialogs(...args: any[]): any;
  endUndoGroup(...args: any[]): any;
  endWatchFolder(...args: any[]): any;
  executeCommand(...args: any[]): any;
  exitAfterLaunchAndEval: any;
  exitCode: any;
  findMenuCommandId(...args: any[]): any;
  fonts: any;
  isoLanguage: any;
  isRenderEngine: any;
  isWatchFolder: any;
  memoryInUse: any;
  newProject(...args: any[]): any;
  onError: any;
  open(...args: any[]): any;
  openFast(...args: any[]): any;
  parseSwatchFile(...args: any[]): any;
  pauseWatchFolder(...args: any[]): any;
  preferences: any;
  project: any;
  purge(...args: any[]): any;
  quit(...args: any[]): any;
  restart(...args: any[]): any;
  saveProjectOnCrash: any;
  scheduleTask(...args: any[]): any;
  setMemoryUsageLimits(...args: any[]): any;
  setMultiFrameRenderingConfig(...args: any[]): any;
  setSavePreferencesOnQuit(...args: any[]): any;
  settings: any;
  version: any;
  watchFolder(...args: any[]): any;
}

declare enum AlphaMode {
  IGNORE,
  STRAIGHT,
  PREMULTIPLIED,
}

declare enum AutoKernType {
  METRIC_KERN,
  OPTICAL_KERN,
  NO_AUTO_KERN,
}

declare enum AutoOrientType {
  ALONG_PATH,
  CAMERA_OR_POINT_OF_INTEREST,
  CHARACTERS_TOWARD_CAMERA,
  NO_AUTO_ORIENT,
}

declare enum BaselineDirection {
  BASELINE_WITH_STREAM,
  BASELINE_VERTICAL_ROTATED,
  BASELINE_VERTICAL_CROSS_STREAM,
}

declare enum BlendingMode {
  ADD,
  ALPHA_ADD,
  CLASSIC_COLOR_BURN,
  CLASSIC_COLOR_DODGE,
  CLASSIC_DIFFERENCE,
  COLOR,
  COLOR_BURN,
  COLOR_DODGE,
  DANCING_DISSOLVE,
  DARKEN,
  DARKER_COLOR,
  DIFFERENCE,
  DISSOLVE,
  DIVIDE,
  EXCLUSION,
  HARD_LIGHT,
  HARD_MIX,
  HUE,
  LIGHTEN,
  LIGHTER_COLOR,
  LINEAR_BURN,
  LINEAR_DODGE,
  LINEAR_LIGHT,
  LUMINESCENT_PREMUL,
  LUMINOSITY,
  MULTIPLY,
  NORMAL,
  OVERLAY,
  PIN_LIGHT,
  SATURATION,
  SCREEN,
  SUBTRACT,
  SILHOUETE_ALPHA,
  SILHOUETTE_LUMA,
  SOFT_LIGHT,
  STENCIL_ALPHA,
  STENCIL_LUMA,
  VIVID_LIGHT,
}

declare enum BoxAutoFitPolicy {
  NONE,
  HEIGHT_CURSOR,
  HEIGHT_PRECISE_BOUNDS,
  HEIGHT_BASELINE,
}

declare enum BoxFirstBaselineAlignment {
  ASCENT,
  CAP_HEIGHT,
  EM_BOX,
  LEADING,
  LEGACY_METRIC,
  MINIMUM_VALUE_ASIAN,
  MINIMUM_VALUE_ROMAN,
  TYPO_ASCENT,
  X_HEIGHT,
}

declare enum BoxVerticalAlignment {
  TOP,
  CENTER,
  BOTTOM,
  JUSTIFY,
}

declare enum ChannelType {
  CHANNEL_ALPHA,
  CHANNEL_ALPHA_BOUNDARY,
  CHANNEL_ALPHA_OVERLAY,
  CHANNEL_BLUE,
  CHANNEL_BLUE_COLORIZE,
  CHANNEL_GREEN,
  CHANNEL_GREEN_COLORIZE,
  CHANNEL_RED,
  CHANNEL_RED_COLORIZE,
  CHANNEL_RGB,
  CHANNEL_RGB_STRAIGHT,
}

declare enum ComposerEngine {
  UNIVERSAL_TYPE_ENGINE,
  LATIN_CJK_ENGINE,
}

declare enum CTFontTechnology {
  CT_TYPE1_FONT,
  CT_TRUETYPE_FONT,
  CT_CID_FONT,
  CT_BITMAP_FONT,
  CT_ATC_FONT,
  CT_TYPE3_FONT,
  CT_SVG_FONT,
  CT_ANYTECHNOLOGY,
}

declare enum CTFontType {
  CT_TYPE1_FONTTYPE,
  CT_TRUETYPE_FONTTYPE,
  CT_CID_FONTTYPE,
  CT_ATC_FONTTYPE,
  CT_BITMAP_FONTTYPE,
  CT_OPENTYPE_CFF_FONTTYPE,
  CT_OPENTYPE_CID_FONTTYPE,
  CT_OPENTYPE_TT_FONTTYPE,
  CT_TYPE3_FONTTYPE,
  CT_SVG_FONTTYPE,
}

declare enum CTScript {
  CT_ROMAN_SCRIPT,
  CT_JAPANESE_SCRIPT,
  CT_TRADITIONALCHINESE_SCRIPT,
  CT_KOREAN_SCRIPT,
  CT_ARABIC_SCRIPT,
  CT_HEBREW_SCRIPT,
  CT_GREEK_SCRIPT,
  CT_CYRILLIC_SCRIPT,
  CT_RIGHTLEFT_SCRIPT,
  CT_DEVANAGARI_SCRIPT,
  CT_GURMUKHI_SCRIPT,
  CT_GUJARATI_SCRIPT,
  CT_ORIYA_SCRIPT,
  CT_BENGALI_SCRIPT,
  CT_TAMIL_SCRIPT,
  CT_TELUGU_SCRIPT,
  CT_KANNADA_SCRIPT,
  CT_MALAYALAM_SCRIPT,
  CT_SINHALESE_SCRIPT,
  CT_BURMESE_SCRIPT,
  CT_KHMER_SCRIPT,
  CT_THAI_SCRIPT,
  CT_LAOTIAN_SCRIPT,
  CT_GEORGIAN_SCRIPT,
  CT_ARMENIAN_SCRIPT,
  CT_SIMPLIFIEDCHINESE_SCRIPT,
  CT_TIBETAN_SCRIPT,
  CT_MONGOLIAN_SCRIPT,
  CT_GEEZ_SCRIPT,
  CT_EASTEUROPEANROMAN_SCRIPT,
  CT_VIETNAMESE_SCRIPT,
  CT_EXTENDEDARABIC_SCRIPT,
  CT_KLINGON_SCRIPT,
  CT_EMOJI_SCRIPT,
  CT_ROHINGYA_SCRIPT,
  CT_JAVANESE_SCRIPT,
  CT_SUNDANESE_SCRIPT,
  CT_LONTARA_SCRIPT,
  CT_SYRIAC_SCRIPT,
  CT_TAITHAM_SCRIPT,
  CT_BUGINESE_SCRIPT,
  CT_BALINESE_SCRIPT,
  CT_CHEROKEE_SCRIPT,
  CT_MANDAIC_SCRIPT,
  CT_VAI_SCRIPT,
  CT_THAANA_SCRIPT,
  CT_BRAVANESE_SCRIPT,
  CT_BRAHMI_SCRIPT,
  CT_CARIAN_SCRIPT,
  CT_CYPRIOT_SCRIPT,
  CT_EGYPTIAN_SCRIPT,
  CT_IMPERIALARAMAIC_SCRIPT,
  CT_PAHLAVI_SCRIPT,
  CT_PARTHIAN_SCRIPT,
  CT_KHAROSHTHI_SCRIPT,
  CT_LYCIAN_SCRIPT,
  CT_LYDIAN_SCRIPT,
  CT_PHOENICIAN_SCRIPT,
  CT_PERSIAN_SCRIPT,
  CT_SHAVIAN_SCRIPT,
  CT_SUMAKKCUNEIFORM_SCRIPT,
  CT_UGARITIC_SCRIPT,
  CT_GLAGOLITIC_SCRIPT,
  CT_GOTHIC_SCRIPT,
  CT_OGHAM_SCRIPT,
  CT_OLDITALIC_SCRIPT,
  CT_ORKHON_SCRIPT,
  CT_RUNIC_SCRIPT,
  CT_MEROITICCURSIVE_SCRIPT,
  CT_COPTIC_SCRIPT,
  CT_OLCHIKI_SCRIPT,
  CT_SORASOMPENG_SCRIPT,
  CT_OLDHANGUL_SCRIPT,
  CT_LISU_SCRIPT,
  CT_NKO_SCRIPT,
  CT_ADLAM_SCRIPT,
  CT_BAMUM_SCRIPT,
  CT_BASSAVAH_SCRIPT,
  CT_NEWA_SCRIPT,
  CT_NEWTAILU_SCRIPT,
  CT_SCRIPT,
  CT_OSAGE_SCRIPT,
  CT_UCAS_SCRIPT,
  CT_TIFINAGH_SCRIPT,
  CT_KAYAHLI_SCRIPT,
  CT_LAO_SCRIPT,
  CT_TAILE_SCRIPT,
  CT_TAIVIET_SCRIPT,
  CT_DONTKNOW_SCRIPT,
}

declare enum DigitSet {
  DEFAULT_DIGITS,
  ARABIC_DIGITS,
  HINDI_DIGITS,
  FARSI_DIGITS,
  ARABIC_DIGITS_RTL,
}

declare enum FastPreviewType {
  FP_OFF,
  FP_ADAPTIVE_RESOLUTION,
  FP_DRAFT,
  FP_FAST_DRAFT,
  FP_WIREFRAME,
}

declare enum FeetFramesFilmType {
  MM16,
  MM35,
}

declare enum FieldSeparationType {
  OFF,
  UPPER_FIELD_FIRST,
  LOWER_FIELD_FIRST,
}

declare enum FontBaselineOption {
  FONT_NORMAL_BASELINE,
  FONT_FAUXED_SUPERSCRIPT,
  FONT_FAUXED_SUBSCRIPT,
}

declare enum FontCapsOption {
  FONT_NORMAL_CAPS,
  FONT_SMALL_CAPS,
  FONT_ALL_CAPS,
  FONT_ALL_SMALL_CAPS,
}

declare enum FootageTimecodeDisplayStartType {
  FTCS_START_0,
  FTCS_USE_SOURCE_MEDIA,
}

declare enum FrameBlendingType {
  FRAME_MIX,
  NO_FRAME_BLEND,
  PIXEL_MOTION,
}

declare enum FramesCountType {
  FC_START_0,
  FC_START_1,
  FC_TIMECODE_CONVERSION,
}

declare enum GetSettingsFormat {
  NUMBER,
  STRING,
  NUMBER_SETTABLE,
  STRING_SETTABLE,
}

declare enum GpuAccelType {
  CUDA,
  OPENCL,
  SOFTWARE,
  METAL,
}

declare enum GuideOrientationType {
  HORIZONTAL,
  VERTICAL,
}

declare enum GuidePositionType {
  PIXEL,
  PERCENTAGE,
}

declare enum ImportAsType {
  COMP_CROPPED_LAYERS,
  FOOTAGE,
  COMP,
  PROJECT,
}

declare enum KeyframeInterpolationType {
  LINEAR,
  BEZIER,
  HOLD,
}

declare enum LayerInputStageType {
  SOURCE = 0,
  ALL_EFFECTS = -1,
  ONLY_MASKS = -2,
}

declare enum LayerQuality {
  BEST,
  DRAFT,
  WIREFRAME,
}

declare enum LayerSamplingQuality {
  BICUBIC,
  BILINEAR,
}

declare enum LeadingType {
  ROMAN_LEADING_TYPE,
  JAPANESE_LEADING_TYPE,
}

declare enum LightType {
  PARALLEL,
  SPOT,
  POINT,
  AMBIENT,
  ENVIRONMENT,
}

declare enum LineJoinType {
  LINE_JOIN_MITER,
  LINE_JOIN_ROUND,
  LINE_JOIN_BEVEL,
}

declare enum LineOrientation {
  HORIZONTAL,
  VERTICAL_RIGHT_TO_LEFT,
  VERTICAL_LEFT_TO_RIGHT,
}

declare enum LogType {
  ERRORS_ONLY,
  ERRORS_AND_SETTINGS,
  ERRORS_AND_PER_FRAME_INFO,
}

declare enum MaskFeatherFalloff {
  FFO_LINEAR,
  FFO_SMOOTH,
}

declare enum MaskMode {
  NONE,
  ADD,
  SUBTRACT,
  INTERSECT,
  LIGHTEN,
  DARKEN,
  DIFFERENCE,
}

declare enum ParagraphDirection {
  DIRECTION_LEFT_TO_RIGHT,
  DIRECTION_RIGHT_TO_LEFT,
}

declare enum ParagraphJustification {
  LEFT_JUSTIFY,
  RIGHT_JUSTIFY,
  CENTER_JUSTIFY,
  FULL_JUSTIFY_LASTLINE_LEFT,
  FULL_JUSTIFY_LASTLINE_RIGHT,
  FULL_JUSTIFY_LASTLINE_CENTER,
  FULL_JUSTIFY_LASTLINE_FULL,
  MULTIPLE_JUSTIFICATIONS,
}

declare enum ParametricMeshType {
  SPHERE,
  PLANE,
  CYLINDER,
  CONE,
  TORUS,
  CUBE,
}

declare enum PostRenderAction {
  NONE,
  IMPORT,
  IMPORT_AND_REPLACE_USAGE,
  SET_PROXY,
}

declare enum PropertyType {
  PROPERTY,
  INDEXED_GROUP,
  NAMED_GROUP,
}

declare enum PropertyValueType {
  NO_VALUE,
  COLOR,
  CUSTOM_VALUE,
  MARKER,
  LAYER_INDEX,
  MASK_INDEX,
  SHAPE,
  TEXT_DOCUMENT,
}

declare enum RQItemStatus {
  QUEUED,
  UNQUEUED,
  WILL_CONTINUE,
  NEEDS_OUTPUT,
  RENDERING,
  USER_STOPPED,
  ERR_STOPPED,
  DONE,
}

declare enum SubstitutedFontReplacementMatchPolicy {
  POSTSCRIPT_NAME,
  CTFI_EQUAL,
  DISABLED,
}

declare enum TimeDisplayType {
  FRAMES,
  TIMECODE,
}

declare enum TrackMatteType {
  ALPHA,
  ALPHA_INVERTED,
  LUMA,
  LUMA_INVERTED,
  NO_TRACK_MATTE,
}

declare enum ViewerType {
  VIEWER_COMPOSITION,
  VIEWER_LAYER,
  VIEWER_FOOTAGE,
}

declare enum CloseOptions {
  DO_NOT_SAVE_CHANGES,
}

declare function clearOutput(...args: any[]): any;
declare function currentFormatToTime(...args: any[]): any;
declare function generateRandomNumber(...args: any[]): any;
declare function getEnumAsString(...args: any[]): any;
declare function isValid(...args: any[]): any;
declare function timeToCurrentFormat(...args: any[]): any;
declare function write(...args: any[]): any;
declare function writeLn(...args: any[]): any;


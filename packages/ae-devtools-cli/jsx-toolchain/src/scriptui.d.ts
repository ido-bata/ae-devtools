/**
 * scriptui.d.ts — PARTIAL ambient declarations for the ScriptUI
 * module (Issue #97).
 *
 * ScriptUI is NOT part of the AE scripting inventory
 * (inventories/scripting/generated/symbols.json), so it is not in the
 * generated ae-api.d.ts. This file is hand-maintained.
 *
 * SOURCES / PROVENANCE
 * - Class names, the inheritance shape, and the member NAMES below are
 *   modeled on types-for-adobe@7.2.6 `shared/ScriptUI.d.ts`
 *   (https://github.com/docsforadobe/Types-for-Adobe,
 *    https://www.npmjs.com/package/types-for-adobe, MIT license,
 *    accessed 2026-11-16), itself derived from Adobe's ScriptUI
 *   documentation (ScriptUI for Adobe applications / JavaScript Tools
 *   Guide).
 * - We deliberately vendor a MINIMAL subset instead of depending on the
 *   package: types-for-adobe's `shared/JavaScript.d.ts` redeclares the
 *   ES5 builtins (`declare const Object/Array/Date/...`) which collide
 *   with the default lib, and its per-app typings would duplicate
 *   ae-api.d.ts.
 *
 * HONEST SCOPE: same convention as ae-globals.d.ts — names and the
 * documented inheritance shape are accurate; every member is `any`-typed
 * because we do not vendor per-member signatures. Declaring the member
 * names (rather than a bare index signature) matters for assignability:
 * TypeScript does not let an index signature satisfy a required
 * property of a structural target type. Absence of a named member is
 * NOT proof the ScriptUI API lacks it — reads still fall through the
 * `[key: string]: any` index signature. Constructors accept
 * `...args: any[]` — arity is not checked.
 *
 * LIB CONSTRAINT: these are ambient GLOBAL declarations (`Window`,
 * `Event`, `Image`, `Point`…) that collide with `lib.dom.d.ts`. They
 * are meant for ExtendScript checking where the DOM lib must NOT be
 * loaded — check.mjs pins `lib: ["lib.es5.d.ts"]`. Consumers including
 * this file in their own tsconfig must do the same.
 */

/** Common base for all ScriptUI elements (mirrors `_Control` in the reference). */
declare class ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  alignment: any;
  bounds: any;
  enabled: any;
  helpTip: any;
  indent: any;
  location: any;
  maximumSize: any;
  minimumSize: any;
  parent: any;
  preferredSize: any;
  size: any;
  type: any;
  visible: any;
  window: any;
  windowBounds: any;
  addEventListener: any;
  dispatchEvent: any;
  findElement: any;
  hide: any;
  removeEventListener: any;
  show: any;
}

/** A top-level window or dialog box (ScriptUI `Window`). */
declare class Window extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  alignChildren: any;
  cancelElement: any;
  characters: any;
  children: any;
  defaultElement: any;
  frameBounds: any;
  frameLocation: any;
  frameSize: any;
  graphics: any;
  justify: any;
  layout: any;
  margins: any;
  maximized: any;
  minimized: any;
  opacity: any;
  orientation: any;
  shortcutKey: any;
  spacing: any;
  text: any;
  add: any;
  center: any;
  close: any;
  notify: any;
  onActivate: any;
  onClose: any;
  onDeactivate: any;
  onMove: any;
  onMoving: any;
  onResize: any;
  onResizing: any;
  onShortcutKey: any;
  onShow: any;
  remove: any;
  static find(type: string, title: string): Window;
}

/** A titled section inside a window. */
declare class Panel extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  alignChildren: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  layout: any;
  margins: any;
  orientation: any;
  spacing: any;
  text: any;
  add: any;
  onDraw: any;
  remove: any;
}

/** A tab inside a TabbedPanel. */
declare class Tab extends Panel {
  [key: string]: any;
  constructor(...args: any[]);
  parent: any;
}

/** A container with tabs. */
declare class TabbedPanel extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  children: any;
  selection: any;
  title: any;
  titleLayout: any;
  add: any;
  onChange: any;
}

/** A layout container for child controls. */
declare class Group extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  alignChildren: any;
  children: any;
  graphics: any;
  layout: any;
  margins: any;
  orientation: any;
  spacing: any;
  add: any;
  onDraw: any;
  remove: any;
}

/** A non-interactive text label. */
declare class StaticText extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  shortcutKey: any;
  text: any;
  notify: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A single-line text input. */
declare class EditText extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  shortcutKey: any;
  text: any;
  textselection: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onChanging: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A push button. */
declare class Button extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  shortcutKey: any;
  text: any;
  notify: any;
  onActivate: any;
  onClick: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** An icon button. */
declare class IconButton extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  graphics: any;
  image: any;
  icon: any;
  shortcutKey: any;
  title: any;
  titleLayout: any;
  notify: any;
  onActivate: any;
  onClick: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** An image-displaying control. */
declare class Image extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  children: any;
  graphics: any;
  image: any;
  icon: any;
  shortcutKey: any;
  title: any;
  titleLayout: any;
  onActivate: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A checkbox (ScriptUI spells it `Checkbox`). */
declare class Checkbox extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  shortcutKey: any;
  text: any;
  value: any;
  notify: any;
  onActivate: any;
  onClick: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A dropdown selection list. */
declare class DropDownList extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  graphics: any;
  itemSize: any;
  items: any;
  selection: any;
  shortcutKey: any;
  title: any;
  titleLayout: any;
  add: any;
  find: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
  remove: any;
  removeAll: any;
}

/** A scrollable list box. */
declare class ListBox extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  columns: any;
  graphics: any;
  itemSize: any;
  items: any;
  selection: any;
  shortcutKey: any;
  add: any;
  find: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onDeactivate: any;
  onDoubleClick: any;
  onDraw: any;
  onShortcutKey: any;
  remove: any;
  removeAll: any;
}

/** An entry inside a ListBox or DropDownList. */
declare class ListItem {
  [key: string]: any;
  constructor(...args: any[]);
  checked: any;
  expanded: any;
  image: any;
  index: any;
  parent: any;
  selected: any;
  subItems: any;
  text: any;
  type: any;
  add: any;
}

/** A horizontal or vertical slider. */
declare class Slider extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  graphics: any;
  maxvalue: any;
  minvalue: any;
  shortcutKey: any;
  value: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onChanging: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A scrollbar. */
declare class Scrollbar extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  graphics: any;
  jumpdelta: any;
  maxvalue: any;
  minvalue: any;
  shortcutKey: any;
  stepdelta: any;
  value: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onChanging: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A radio button (members of a radio group share a `groupName`). */
declare class RadioButton extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  characters: any;
  children: any;
  graphics: any;
  justify: any;
  shortcutKey: any;
  text: any;
  value: any;
  notify: any;
  onActivate: any;
  onClick: any;
  onDeactivate: any;
  onDraw: any;
  onShortcutKey: any;
}

/** A progress indicator bar (ScriptUI spells it `Progressbar`). */
declare class Progressbar extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  children: any;
  graphics: any;
  maxvalue: any;
  minvalue: any;
  value: any;
  onDraw: any;
}

/** A tree-view control. */
declare class TreeView extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  children: any;
  graphics: any;
  itemSize: any;
  items: any;
  selection: any;
  shortcutKey: any;
  add: any;
  find: any;
  notify: any;
  onActivate: any;
  onChange: any;
  onCollapse: any;
  onDeactivate: any;
  onDraw: any;
  onExpand: any;
  onShortcutKey: any;
  remove: any;
  removeAll: any;
}

/** A Flash Player control (loads SWF movies). */
declare class FlashPlayer extends ScriptUIControl {
  [key: string]: any;
  constructor(...args: any[]);
  active: any;
  title: any;
  titleLayout: any;
  callback: any;
  invokePlayerFunction: any;
  loadMovie: any;
  notify: any;
  playMovie: any;
  stopMovie: any;
}

/** A 2-element size value ([width, height]); array-like with width/height. */
declare class Dimension extends Array<number> {
  width?: any;
  height?: any;
}

/** A bounding rectangle ([left, top, right, bottom]); array-like. */
declare class Bounds extends Array<number> {
  bottom?: any;
  height?: any;
  left?: any;
  right?: any;
  top?: any;
  width?: any;
  x?: any;
  y?: any;
}

/** A 2-element point ([x, y]); array-like with x/y accessors. */
declare class Point extends Array<number> {
  left?: any;
  top?: any;
  x?: any;
  y?: any;
}

/** A 4-element margin value ([left, top, right, bottom]); array-like. */
declare class Margins extends Array<number> {
  left?: any;
  right?: any;
  top?: any;
  bottom?: any;
}

/** The drawing surface passed to `onDraw` handlers. */
declare class ScriptUIGraphics {
  [key: string]: any;
  constructor(...args: any[]);
  backgroundColor: any;
  currentPath: any;
  currentPoint: any;
  disabledBackgroundColor: any;
  disabledForegroundColor: any;
  font: any;
  foregroundColor: any;
  closePath: any;
  drawFocusRing: any;
  drawImage: any;
  drawOSControl: any;
  drawString: any;
  ellipsePath: any;
  fillPath: any;
  lineTo: any;
  measureString: any;
  moveTo: any;
  newBrush: any;
  newPath: any;
  newPen: any;
  rectPath: any;
  strokePath: any;
}

/** State passed to draw-event handlers (modifier keys / mouse buttons). */
declare class DrawState {
  [key: string]: any;
  constructor(...args: any[]);
  altKeyPressed: any;
  capsLockKeyPressed: any;
  cmdKeyPressed: any;
  ctrlKeyPressed: any;
  hasFocus: any;
  leftButtonPressed: any;
  middleButtonPressed: any;
  mouseOver: any;
  numLockKeyPressed: any;
  optKeyPressed: any;
  rightButtonPressed: any;
  shiftKeyPressed: any;
}

/** A ScriptUI font object (from `ScriptUI.newFont`). */
declare class ScriptUIFont {
  [key: string]: any;
  constructor(...args: any[]);
  family: any;
  name: any;
  size: any;
  style: any;
  substitute: any;
}

/** A ScriptUI image object (from `ScriptUI.newImage`). */
declare class ScriptUIImage {
  [key: string]: any;
  constructor(...args: any[]);
  format: any;
  name: any;
  pathname: any;
  size: any;
}

/** A solid/gradient fill description for graphics drawing. */
declare class ScriptUIBrush {
  [key: string]: any;
  constructor(...args: any[]);
  color: any;
  theme: any;
  type: any;
}

/** A pen/stroke description for graphics drawing. */
declare class ScriptUIPen {
  [key: string]: any;
  constructor(...args: any[]);
  color: any;
  lineWidth: any;
  theme: any;
  type: any;
}

/** A vector path for graphics drawing. */
declare class ScriptUIPath {
  [key: string]: any;
  constructor(...args: any[]);
}

/** An auto-layout manager for a container. */
declare class AutoLayoutManager {
  [key: string]: any;
  constructor(...args: any[]);
  layout: any;
  resize: any;
}

/** ScriptUI event objects (created via `ScriptUI.events.createEvent`). */
declare class UIEvent {
  [key: string]: any;
  constructor(...args: any[]);
  bubbles: any;
  cancelable: any;
  captures: any;
  currentTarget: any;
  detail: any;
  eventPhase: any;
  target: any;
  timeStamp: any;
  type: any;
  view: any;
  initEvent: any;
  initUIEvent: any;
  preventDefault: any;
  stopPropagation: any;
}

/** ScriptUI event (keyboard/mouse/panel events). */
declare class Event {
  [key: string]: any;
  constructor(...args: any[]);
  bubbles: any;
  cancelable: any;
  captures: any;
  currentTarget: any;
  eventPhase: any;
  target: any;
  timeStamp: any;
  type: any;
  preventDefault: any;
  stopPropagation: any;
}

/** ScriptUI environment information. */
declare class Environment {
  [key: string]: any;
  constructor(...args: any[]);
  keyboardState: any;
}

/** ScriptUI event-system facade (`ScriptUI.events`). */
declare class Events {
  [key: string]: any;
  constructor(...args: any[]);
  createEvent: any;
}

/** Keyboard modifier state for ScriptUI events. */
declare class KeyboardState {
  [key: string]: any;
  constructor(...args: any[]);
  altKey: any;
  ctrlKey: any;
  keyName: any;
  metaKey: any;
  shiftKey: any;
}

/** A keyboard event. */
declare class KeyboardEvent extends UIEvent {
  [key: string]: any;
  constructor(...args: any[]);
  altKey: any;
  ctrlKey: any;
  metaKey: any;
  shiftKey: any;
  keyIdentifier: any;
  keyLocation: any;
  keyName: any;
  type: any;
  getModifierState: any;
  initKeyboardEvent: any;
}

/**
 * The global `ScriptUI` object: a namespace of factory functions and
 * constants, not instantiable. Only the entry points confirmed in the
 * reference typings are named; everything else falls through the index
 * signature.
 */
declare const ScriptUI: {
  newFont(name?: string, style?: string, size?: number): ScriptUIFont;
  newImage(
    normal?: string,
    disabled?: string,
    pressed?: string,
    rollover?: string,
  ): ScriptUIImage;
  getResourceText(text: string): string;
  [key: string]: any;
};

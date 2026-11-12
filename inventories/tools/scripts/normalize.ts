/**
 * CAP003 name normalization: raw tool operation name -> provisional semantic id.
 *
 * The id grammar and final catalog schema are owned by ae-devtools#11; every id
 * produced here is provisional. The goal of this module is de-duplication: the
 * same Adobe operation reached through several wrappers must land on ONE id so
 * the gap matrix does not double-count it.
 *
 * Strategy:
 *   1. canonicalName(): camelCase -> snake_case, strip `ae_` prefixes.
 *   2. ALIASES: explicit cross-tool synonyms (the operations whose identity I
 *      verified by reading the implementations).
 *   3. Derived fallback: `<domain>.<canonical-name-kebab>` using the domain
 *      keyword found in the name — same-named operations across tools still
 *      collapse to one id even without an alias.
 */

/** Domain keyword -> canonical first segment. */
const DOMAIN_KEYWORDS: [string, string][] = [
  ["composition", "comp"],
  ["comps", "comp"],
  ["comp", "comp"],
  ["project", "project"],
  ["footage", "footage"],
  ["asset", "footage"],
  ["expression", "expression"],
  ["keyframe", "keyframe"],
  ["keys", "keyframe"],
  ["marker", "marker"],
  ["markers", "marker"],
  ["mask", "mask"],
  ["masks", "mask"],
  ["shape", "shape"],
  ["shapes", "shape"],
  ["geometry", "geometry"],
  ["material", "material"],
  ["camera", "camera"],
  ["light", "light"],
  ["layer", "layer"],
  ["layers", "layer"],
  ["effect", "effect"],
  ["effects", "effect"],
  ["fx", "effect"],
  ["render", "render"],
  ["text", "text"],
  ["path", "path"],
  ["paths", "path"],
  ["menu", "menu"],
  ["preference", "preference"],
  ["preferences", "preference"],
  ["audio", "audio"],
  ["view", "view"],
  ["viewer", "view"],
  ["capture", "view"],
  ["snapshot", "view"],
  ["time", "time"],
  ["timing", "time"],
  ["retime", "time"],
  ["subtitle", "subtitle"],
  ["motion", "motion"],
  ["mogrt", "mogrt"],
  ["style", "style"],
  ["search", "search"],
  ["find", "search"],
  ["edit", "edit"],
  ["system", "system"],
  ["health", "system"],
  ["ping", "system"],
  ["bridge", "system"],
  ["app", "app"],
  ["version", "app"],
  ["ui", "ui"],
  ["alert", "ui"],
  ["proxy", "proxy"],
  ["audio-reactive", "audio"],
];

/**
 * Explicit aliases: canonical snake name -> semantic id. Only operations whose
 * implementations I read are listed here; anything else falls back to deriving.
 */
export const ALIASES: Record<string, string> = {
  // project
  get_project_info: "project.info",
  project_info: "project.info",
  get_project: "project.info",
  list_project_items: "project.list-items",
  list_projects: "project.list-items",
  project_search: "project.search",
  search_project: "project.search",
  open_project: "project.open",
  create_project: "project.create",
  save_project: "project.save",
  save_project_as: "project.save-as",
  close_project: "project.close",
  import_footage: "footage.import",
  import_file: "footage.import",
  import_image_sequence: "footage.import-sequence",
  // comp
  create_composition: "comp.create",
  create_comp: "comp.create",
  modify_composition: "comp.update-settings",
  duplicate_composition: "comp.duplicate",
  delete_composition: "comp.delete",
  list_compositions: "project.list-comps",
  get_composition_info: "comp.info",
  composition_info: "comp.info",
  get_comp: "comp.info",
  get_composition: "comp.info",
  set_active_composition: "comp.set-active",
  get_active_composition: "comp.get-active",
  comp_open_in_viewer: "comp.open-in-viewer",
  open_in_viewer: "comp.open-in-viewer",
  get_comp_report: "comp.get-report",
  render_frame: "render.frame",
  render_current_frame: "render.frame",
  add_solid_layer: "layer.add-solid",
  add_text_layer: "layer.add-text",
  add_text_layer_advanced: "layer.add-text",
  add_shape_layer: "layer.add-shape",
  add_camera: "layer.add-camera",
  add_light: "layer.add-light",
  add_null_layer: "layer.add-null",
  duplicate_layer: "layer.duplicate",
  delete_layer: "layer.delete",
  set_layer_properties: "layer.set-properties",
  batch_set_layer_properties: "layer.set-properties",
  set_layer_enabled: "layer.set-enabled",
  set_layer_position: "layer.set-transform",
  set_layer_transform: "layer.set-transform",
  get_layer_info: "layer.info",
  get_layer_transform: "layer.get-transform",
  get_layers: "layer.list",
  list_layers: "layer.list",
  select_layer: "layer.select",
  set_layer_mask: "layer.set-mask",
  set_layer_expression: "expression.set",
  set_expression: "expression.set",
  get_expression: "expression.get",
  remove_expression: "expression.remove",
  apply_preset: "motion.apply-preset",
  apply_animation_preset: "motion.apply-preset",
  // effects
  apply_effect: "effect.apply",
  apply_effect_template: "effect.apply",
  remove_effect: "effect.remove",
  list_effects: "layer.list-effects",
  get_effect_info: "effect.info",
  set_effect_property: "effect.set-parameter",
  set_effect_settings: "effect.set-parameter",
  get_effect_parameters: "effect.list-parameters",
  // keyframes
  set_layer_keyframe: "keyframe.set",
  set_keyframe: "keyframe.set",
  set_keyframes: "keyframe.set",
  set_path_keyframes: "keyframe.set-path",
  get_current_time: "comp.get-time",
  set_current_time: "comp.set-time",
  snap_to_marker: "marker.snap",
  get_nearest_marker: "marker.get-nearest",
  navigate_markers: "marker.navigate",
  add_marker: "marker.add",
  list_markers: "marker.list",
  // paths / masks / shapes
  create_path: "path.create",
  get_path: "path.get",
  add_shape_operator: "shape.add-operator",
  add_mask: "mask.add",
  // 3d / camera / light / geometry / material
  get_3d_info: "layer.get-3d-info",
  set_3d_layer: "layer.set-3d",
  set_material_options: "material.set",
  set_geometry_options: "geometry.set",
  set_camera_options: "camera.set-options",
  set_light_options: "light.set-options",
  set_comp_renderer: "comp.set-renderer",
  set_proxy: "footage.set-proxy",
  remove_proxy: "footage.remove-proxy",
  // system / ui / menu
  health: "system.health",
  ae_health: "system.health",
  ping: "system.ping",
  run_script: "system.run-jsx",
  run_jsx: "system.run-jsx",
  execute_menu_command: "menu.execute-command",
  find_menu_command: "menu.find-command",
  show_alert: "ui.alert",
  get_help: "system.get-help",
};

export function canonicalName(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^ae_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function domainOf(canonical: string): string | null {
  for (const [kw, domain] of DOMAIN_KEYWORDS) {
    if (canonical === kw || canonical.startsWith(`${kw}_`) || canonical.endsWith(`_${kw}`) || canonical.includes(`_${kw}_`)) {
      return domain;
    }
  }
  return null;
}

/** Raw tool name -> provisional semantic id. */
export function semanticFor(raw: string): string {
  const canonical = canonicalName(raw);
  const alias = ALIASES[canonical];
  if (alias) return alias;
  const domain = domainOf(canonical);
  const kebab = canonical.replace(/_/g, "-");
  return domain ? `${domain}.${kebab}` : `tool.${kebab}`;
}

/** Human label for a derived id (curated ids override this in semantics.ts). */
export function humanize(id: string): string {
  const rest = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  const words = rest.replace(/-/g, " ").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

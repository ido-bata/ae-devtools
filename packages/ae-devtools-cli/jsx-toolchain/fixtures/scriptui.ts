/**
 * scriptui.ts — fixture for Issue #97: ScriptUI classes, ExtendScript
 * host objects (File/Folder/$), AE classes used as values
 * (instanceof/new), and the PREFType enum must all typecheck.
 */

function buildPanel(): Window {
  const win = new Window("dialog", "Fixture", undefined, { resizeable: true });
  win.orientation = "column";
  win.alignChildren = ["fill", "top"];
  win.margins = 12;
  win.spacing = 8;

  const group: Group = win.add("group");
  group.orientation = "row";
  const label: StaticText = group.add("statictext", undefined, "hello");
  label.text = "world";
  void label;

  const edit = new EditText(win, "field", "initial");
  edit.text = "changed";
  const button = new Button(group, "go");
  button.onClick = function () {
    $.writeln(edit.text);
  };
  const box = new Checkbox(group, "opt");
  box.value = true;
  const list = new DropDownList(group, undefined, ["a", "b"]);
  list.selection = 0;
  const slider = new Slider(group, 0, 100, 50);
  void slider;
  const dim: Dimension = [10, 20];
  group.preferredSize = dim;

  const folder = new Folder(Folder.userData.fsName + "/fixture");
  const file = new File(folder.fsName + "/out.txt");
  file.encoding = "UTF8";
  if (file.open("w")) {
    const written: boolean = file.write("ok");
    file.close();
    void written;
  }
  void file.remove;

  const item = app.project.items[0];
  const isComp = item instanceof CompItem;
  const ease = new KeyframeEase(0.5, 75);
  void isComp;
  void ease;

  const pref = PREFType.PREF_Type_MACHINE_INDEPENDENT;
  void pref;

  const graphics: ScriptUIGraphics = label.graphics;
  void graphics;

  return win;
}

void buildPanel;

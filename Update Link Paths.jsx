// Update Link Paths.jsx
// Recursive linked Smart Object path switcher.
// Walks the active document (descending into LayerSets/groups), shows the
// first linked Smart Object's current path, asks the user to pick a new
// links folder, then repoints every linked Smart Object at every depth —
// across groups and across nested smart object contents — to
// <newFolder>/<originalFilename>. Handles broken links via the
// fileReference fallback. Saves nested PSD/PSB documents as it ascends.
//
// Layer/group name tags (case-insensitive, anywhere in the name):
//   [IGNORE]  Skip this layer or group entirely (and everything inside it).
//   [UPDATE]  On an embedded smart object: force-open it, relink anything
//             inside, save it back. (Embedded SOs are otherwise skipped.)
//   [ALL]     On a group or smart object: force-recurse through every smart
//             object inside (linked and embedded), at every nesting depth,
//             including nested smart-object contents. [IGNORE] still wins.

#target photoshop

var MAX_DEPTH = 8;
var IGNORE_RE = /\[ignore\]/i;
var UPDATE_RE = /\[update\]/i;
var ALL_RE = /\[all\]/i;

var gNewFolderPath = null;
var gRelinkCount = 0;
var gRootDocName = "";
var gRootDocPath = null;
var gDebugFile = null;

function dbg(msg) {
    try {
        if (!gDebugFile) return;
        gDebugFile.open("a");
        gDebugFile.writeln(msg);
        gDebugFile.close();
    } catch (e) {}
}

function openDebugLog() {
    try {
        var f = new File("~/Desktop/UpdateLinkPathsDebug.txt");
        f.encoding = "UTF8";
        f.open("w");
        f.writeln("Update Link Paths debug log " + new Date());
        f.close();
        gDebugFile = f;
    } catch (e) {}
}

function s2t(s) { return app.stringIDToTypeID(s); }
function c2t(c) { return app.charIDToTypeID(c); }

function safeAMGet(ref) {
    try { return executeActionGet(ref); } catch (e) { return null; }
}

function safeAMAction(evtID, desc, mode) {
    try {
        executeAction(evtID, desc || undefined, mode !== undefined ? mode : DialogModes.NO);
        return true;
    } catch (e) {
        return false;
    }
}

function rememberRootDocument() {
    var d = app.activeDocument;
    gRootDocName = d.name;
    try { gRootDocPath = d.fullName; } catch (e) { gRootDocPath = null; }
}

function activateRootDocument() {
    var i, d;
    if (gRootDocPath) {
        for (i = 0; i < app.documents.length; i++) {
            d = app.documents[i];
            try {
                if (d.fullName && d.fullName.fsName === gRootDocPath.fsName) {
                    app.activeDocument = d;
                    return true;
                }
            } catch (e) {}
        }
    }
    for (i = 0; i < app.documents.length; i++) {
        if (app.documents[i].name === gRootDocName) {
            app.activeDocument = app.documents[i];
            return true;
        }
    }
    return false;
}

function amSelectLayerById(layerId) {
    var desc = new ActionDescriptor();
    var ref  = new ActionReference();
    ref.putIdentifier(s2t("layer"), layerId);
    desc.putReference(s2t("null"), ref);
    try { desc.putBoolean(s2t("makeVisible"), false); } catch (e) {}
    return safeAMAction(s2t("select"), desc, DialogModes.NO);
}

function amEditContents() {
    return safeAMAction(s2t("placedLayerEditContents"), undefined, DialogModes.NO);
}

function amCloseWithSave() {
    var desc = new ActionDescriptor();
    desc.putEnumerated(s2t("saving"), s2t("saveChangesOptions"), s2t("yes"));
    return safeAMAction(s2t("close"), desc, DialogModes.NO);
}

function descKeys(d) {
    var keys = [];
    try {
        for (var i = 0; i < d.count; i++) {
            keys.push(app.typeIDToStringID(d.getKey(i)));
        }
    } catch (e) {}
    return keys.join(",");
}

// Returns info about the active layer's linked-smart-object reference:
//   { fullPath, filename, broken: false }  — working link
//   { fullPath: null, filename, broken: true } — broken link (only fileReference present)
//   null — not a linked Smart Object (embedded or non-SO)
function getLinkedFileInfo() {
    var ref = new ActionReference();
    ref.putProperty(c2t("Prpr"), s2t("smartObject"));
    ref.putEnumerated(c2t("Lyr "), c2t("Ordn"), c2t("Trgt"));
    var desc = safeAMGet(ref);
    if (!desc) { dbg("    info: AMGet null"); return null; }
    if (!desc.hasKey(s2t("smartObject"))) { dbg("    info: no smartObject key"); return null; }
    var so = desc.getObjectValue(s2t("smartObject"));
    if (!so.hasKey(s2t("linked"))) { dbg("    info: no linked key; keys=" + descKeys(so)); return null; }
    if (!so.getBoolean(s2t("linked"))) { dbg("    info: embedded (linked=false)"); return null; }
    var linkKey = s2t("link");
    if (so.hasKey(linkKey)) {
        var vt = so.getType(linkKey);
        var p = null;
        try {
            if (vt == DescValueType.ALIASTYPE) p = so.getPath(linkKey).fsName;
            else if (vt == DescValueType.STRINGTYPE) p = so.getString(linkKey);
            else dbg("    info: link key unknown type=" + vt);
        } catch (e) { dbg("    info: link read threw: " + (e.message || e)); }
        if (p) return { fullPath: p, filename: filenameFromPath(p), broken: false };
    }
    var frKey = s2t("fileReference");
    if (so.hasKey(frKey)) {
        try {
            var fr = so.getString(frKey);
            dbg("    info: broken — fileReference=" + fr);
            return { fullPath: null, filename: filenameFromPath(fr), broken: true };
        } catch (e) { dbg("    info: fileReference unreadable; keys=" + descKeys(so)); }
    }
    dbg("    info: neither link nor fileReference; keys=" + descKeys(so));
    return null;
}

function relinkActiveLayer(newFullPath) {
    var desc = new ActionDescriptor();
    desc.putPath(c2t("null"), new File(newFullPath));
    executeAction(s2t("placedLayerRelinkToFile"), desc, DialogModes.NO);
}

function filenameFromPath(p) {
    var slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.substring(slash + 1) : p;
}

// Walk the DOM (recursing into LayerSets) and return every smart-object
// layer in the active document at any nesting depth in groups, as
// { id, name, forceUpdate }. Layers/groups whose name contains [IGNORE]
// (case-insensitive) are skipped along with their entire subtree.
function collectAllSmartObjects(inheritedAll) {
    var out = [];
    function walk(container, inheritedFromAncestors) {
        var layers;
        try { layers = container.layers; } catch (e) { return; }
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            try {
                var name = "";
                try { name = L.name || ""; } catch (en) {}
                if (IGNORE_RE.test(name)) { dbg("  [IGNORE] " + name); continue; }
                if (L.typename === "LayerSet") {
                    var childInherited = inheritedFromAncestors || ALL_RE.test(name);
                    walk(L, childInherited);
                } else if (L.typename === "ArtLayer" && L.kind === LayerKind.SMARTOBJECT) {
                    var thisAll = inheritedFromAncestors || ALL_RE.test(name);
                    out.push({
                        id: L.id,
                        name: name,
                        forceUpdate: UPDATE_RE.test(name),
                        effectiveAll: thisAll
                    });
                }
            } catch (e) {}
        }
    }
    walk(app.activeDocument, !!inheritedAll);
    return out;
}

function describeLayerTree(container, indent) {
    var layers;
    try { layers = container.layers; } catch (e) { return; }
    if (!layers) return;
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var line = indent + "- ";
        try { line += L.typename; } catch (e) { line += "?"; }
        try { line += " name=\"" + L.name + "\""; } catch (e) {}
        try { line += " kind=" + L.kind; } catch (e) {}
        try { line += " id=" + L.id; } catch (e) {}
        dbg(line);
        try {
            if (L.typename === "LayerSet") describeLayerTree(L, indent + "  ");
        } catch (e) {}
    }
}

function processCurrentDocument(depth, inheritedAll) {
    if (depth >= MAX_DEPTH) { dbg("depth cap hit at " + depth); return; }
    var thisDoc = app.activeDocument;
    var sos = collectAllSmartObjects(inheritedAll);
    dbg("depth=" + depth + " doc=" + thisDoc.name +
        " smartObjects=" + sos.length + " inheritedAll=" + !!inheritedAll);
    if (sos.length === 0 && depth > 0) {
        dbg("  layer tree (debug — no SOs found):");
        describeLayerTree(thisDoc, "    ");
    }
    for (var j = 0; j < sos.length; j++) {
        var so = sos[j];
        try { app.activeDocument = thisDoc; } catch (eAct) { dbg("  reactivate failed: " + eAct); return; }
        if (!amSelectLayerById(so.id)) { dbg("  select failed id=" + so.id); continue; }
        var info = getLinkedFileInfo();
        var childAll = so.effectiveAll;

        if (info) {
            // Linked SO: relink at this level, then descend into its contents if it opens.
            var newPath = gNewFolderPath + "/" + info.filename;
            var oldStr = info.broken ? "(broken — " + info.filename + ")" : info.fullPath;
            dbg("  relink id=" + so.id + " \"" + so.name + "\" " + oldStr + " -> " + newPath +
                (childAll ? " [ALL]" : ""));
            try {
                relinkActiveLayer(newPath);
                gRelinkCount++;
            } catch (e) {
                dbg("  relink threw: " + (e.message || e));
                continue;
            }
            var prevCount = app.documents.length;
            if (!amEditContents()) { dbg("  editContents failed"); continue; }
            if (app.documents.length > prevCount) {
                dbg("  descended into " + app.activeDocument.name);
                processCurrentDocument(depth + 1, childAll);
                amCloseWithSave();
                try { app.activeDocument = thisDoc; } catch (eR) {}
            } else {
                dbg("  no nested doc opened");
            }
        } else if (so.forceUpdate || so.effectiveAll) {
            // Embedded SO: open if it has [UPDATE], or is inside an [ALL] scope.
            var reason = so.effectiveAll ? "[ALL]" : "[UPDATE]";
            dbg("  " + reason + " forcing open on non-linked id=" + so.id + " \"" + so.name + "\"");
            var prevCount2 = app.documents.length;
            if (!amEditContents()) { dbg("  editContents failed (forced)"); continue; }
            if (app.documents.length > prevCount2) {
                dbg("  descended (forced) into " + app.activeDocument.name);
                processCurrentDocument(depth + 1, childAll);
                amCloseWithSave();
                try { app.activeDocument = thisDoc; } catch (eR2) {}
            } else {
                dbg("  " + reason + " could not open contents as a doc");
            }
        } else {
            dbg("  skip (not linked, no [UPDATE]/[ALL]) id=" + so.id + " \"" + so.name + "\"");
        }
    }
}

// Walks the active doc (groups too, honoring [IGNORE]) and returns info on
// the first linked SO it finds, or null.
function findFirstLinkedInfo() {
    var sos = collectAllSmartObjects(false);
    for (var i = 0; i < sos.length; i++) {
        if (!amSelectLayerById(sos[i].id)) continue;
        var info = getLinkedFileInfo();
        if (info) return info;
    }
    return null;
}

// One-shot Photoshop event that collapses every group in the active doc.
// Source: https://stackoverflow.com/a/59707640 (Vlad Moyseenko, CC BY-SA 4.0)
function collapseAllGroups() {
    safeAMAction(s2t("collapseAllGroupsEvent"), new ActionDescriptor(), DialogModes.NO);
}

function doRelink() {
    activateRootDocument();
    processCurrentDocument(0, false);
}

function main() {
    if (!app.documents.length) {
        alert("Open a document first.");
        return;
    }

    rememberRootDocument();
    openDebugLog();
    dbg("root=" + gRootDocName);

    var firstInfo = findFirstLinkedInfo();
    if (!firstInfo) {
        alert("No linked Smart Objects found in this document.");
        return;
    }

    var firstMsg = firstInfo.broken
        ? "Current link is broken.\nFilename: " + firstInfo.filename
        : "Current linked path:\n\n" + firstInfo.fullPath;
    alert(firstMsg);

    var newFolder = Folder.selectDialog("Select the new links folder");
    if (!newFolder) return;
    gNewFolderPath = newFolder.fsName;
    gRelinkCount = 0;

    activateRootDocument();
    app.activeDocument.suspendHistory("Update Link Paths (Recursive)", "doRelink()");

    // Run the collapse as a separate top-level operation, AFTER suspendHistory
    // returns. Inside suspendHistory the collapseAllGroupsEvent is silently
    // ignored; here it behaves exactly like the standalone test script.
    activateRootDocument();
    collapseAllGroups();

    dbg("done. count=" + gRelinkCount);
    alert("Relinked " + gRelinkCount + " layer(s) (all depths) to:\n" + gNewFolderPath +
          "\n\nDebug log: ~/Desktop/UpdateLinkPathsDebug.txt");
}

app.displayDialogs = DialogModes.NO;
try {
    main();
} catch (eOuter) {
    alert("Script error: " + (eOuter.message || String(eOuter)));
} finally {
    app.displayDialogs = DialogModes.ALL;
}

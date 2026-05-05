// Collapse All Groups Test.jsx
// Collapses every group in the active document.
// Source: https://stackoverflow.com/a/59707640 (Vlad Moyseenko, CC BY-SA 4.0)

#target photoshop

function collapseAllGroups() {
    var desc = new ActionDescriptor();
    executeAction(stringIDToTypeID("collapseAllGroupsEvent"), desc, DialogModes.NO);
}

if (!app.documents.length) {
    alert("Open a document first.");
} else {
    collapseAllGroups();
}

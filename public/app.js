'use strict'

/*
 * Calculated Paths page: switches between the status view and the editor.
 *
 * The address ends in #status or #edit, so each view can be linked to and
 * the browser's back button moves between them. The Edit tab appears only
 * for a login that may change the entries.
 */

;(function () {
  const tabs = document.getElementById('views')
  const statusTab = document.getElementById('tab-status')
  const editTab = document.getElementById('tab-edit')
  const statusView = document.getElementById('status-view')
  const editView = document.getElementById('edit-view')
  const unsaved = document.getElementById('unsaved-mark')

  window.CalcPaths.app = {
    /** Marks the Edit tab while the editor holds changes not yet saved. */
    setUnsaved (on) {
      unsaved.hidden = !on
    }
  }

  function show () {
    const editing = window.location.hash === '#edit'
    statusView.hidden = editing
    editView.hidden = !editing
    statusTab.toggleAttribute('aria-current', !editing)
    if (!editing) statusTab.setAttribute('aria-current', 'page')
    editTab.toggleAttribute('aria-current', editing)
    if (editing) editTab.setAttribute('aria-current', 'page')
    if (editing) {
      window.CalcPaths.status.hide()
      tabs.hidden = false
      window.CalcPaths.editor.show()
    } else {
      window.CalcPaths.editor.hide()
      window.CalcPaths.status.show()
    }
  }

  window.addEventListener('hashchange', show)
  show()
  window.CalcPaths.editor.probe().then((permitted) => {
    if (permitted) tabs.hidden = false
  })
})()

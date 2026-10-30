# Project credential settings

Project token settings use credential metadata only. Key the binding editor by project identity so a late response from one project cannot overwrite another project's selection. Loading or saving must disable conflicting edits; failed saves must remain visibly unsaved. Changes apply to subsequent agent runs, not processes already running.

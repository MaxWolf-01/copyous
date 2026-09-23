# Copyous

A clipboard manager for GNOME Shell: it keeps what is copied and shows it in a dialog to paste or copy again.

## Language

**Entry**:
One thing that was copied, as the history keeps it, with its pin, tag and title.
_Avoid_: Clip, record, item
_In code_: `ClipboardEntry`

**Item**:
The widget in the dialog that shows one entry.
_Avoid_: Card, row, entry
_In code_: `ClipboardItem`

**History**:
Every entry kept, newest first.
_Avoid_: List, log

**Search query**:
What the dialog's search asks for: a text, and whether to keep only pinned entries, entries with one tag, or entries of one type.
_In code_: `SearchQuery`

**Match**:
An entry the search query selects. With an empty search query, every entry matches.
_Avoid_: Result, hit

**List window**:
The run of matches the dialog shows. Only entries in the list window have their items shown, so the length of the history costs nothing on screen.
_Avoid_: Window (alone: the preferences have one), page, viewport, visible range
_In code_: `windowSize`

**Reveal**:
Moving an end of the list window to take in more matches, as scrolling or the keyboard nears it.
_Avoid_: Load more, expand

**Prewarm**:
Computing an item's styles and text layout while it is hidden, so the frame that first shows it has less to do.
_In code_: `prewarm`

**Fold**:
The form of a text that search compares: lower case, without accents, so a plain substring test finds what a comparison of base letters would.
_Avoid_: Normalize
_In code_: `fold`

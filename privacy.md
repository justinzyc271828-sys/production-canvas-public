# Privacy information

Production Canvas is a local Windows film-review application. Its default
sample consists of synthetic pictures and tones. The included MCP adapter
connects to a running local application over authenticated loopback.

## Local storage

The application stores its selected projects and settings in its local user
profile. Director notes belong to the selected project's `.production-canvas`
directory. The app creates an ephemeral local session descriptor so that the
adapter can authenticate. Session tokens are omitted from MCP responses.

## Information returned to an assistant

Requested MCP operations can return project identifiers and local paths,
video-version hashes, timeline information, displayed-frame state, director
text, application screenshots, and selected frame contact sheets. The
requesting AI client processes those results under its own account settings
and privacy terms. Users should select only material they want that client to
access. A local adapter does not make the AI client's processing local.

## Optional integrations

User-configured production tools have their own storage and communication
behavior. The candidate does not include the author's production bindings,
accounts, media, notes, or session credentials. It does not include another
person's third-party account connection.

## Support and deletion

Users can close the app and remove the extracted package. Their original
project directories and saved notes remain independent. Support reports are
submitted only when the user chooses to submit them. Avoid attaching private
media, session descriptors, access tokens, and confidential director notes.

This local document is a submission draft. A public support/privacy location
and verified publisher identity are pending the author's publishing decision.

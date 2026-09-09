# Credits

Almost everything in Arena Nova is generated procedurally at runtime — the
terrain, the vegetation, the cathedral, the textures, the animals and the sound.
The exceptions are listed here.

## Character model

**KayKit Pirate Pack** by [Kay Lousberg](https://kaylousberg.com/) —
<https://kaylousberg.itch.io/>

Licence: **CC0 1.0 Universal** (public domain dedication). Attribution is not
legally required; it is here because the work deserves it.

Used for the player and for other players' avatars. Seven characters make up the
selectable library: the default is `public/models/character.glb` (Captain
Barbarossa), the rest live in `public/models/characters/`. All shipped converted
to GLB and compressed with Meshopt — roughly 1.3 MB of `.gltf` each becomes
290–370 kB, and only the chosen one is downloaded.

The pack also contains rigged animation clips (`Idle`, `Walk`, `Run`, `Jump`,
`Jump_Idle`, `Jump_Land`, and others) which the engine maps onto its locomotion
states.

## Transition indicator

`public/ui/transition.gif` was supplied by the project owner. Its origin and
licence are not established here, so if the game is distributed more widely it is
worth replacing with artwork of known provenance. The code needs no change: any
GIF or PNG dropped in at that path is picked up, and a missing file simply leaves
the plain dark transition screen.

## Libraries

| Library | Licence |
| --- | --- |
| [three.js](https://threejs.org/) | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Zlib |
| [Tauri](https://tauri.app/) | MIT / Apache-2.0 |
| [Vite](https://vite.dev/) | MIT |

## Test assets (not shipped)

During development the **Fox** model from
[glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox)
was used to verify the GLTF loader. Model © PixelMannen (CC0), rig and animation
© tomkranis (CC BY 4.0). It is not part of any release.

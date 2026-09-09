# Credits

Almost everything in Arena Nova is generated procedurally at runtime — the
terrain, the vegetation, the cathedral, the textures, the animals and the sound.
The exceptions are listed here.

## Character model

**KayKit Pirate Pack** by [Kay Lousberg](https://kaylousberg.com/) —
<https://kaylousberg.itch.io/>

Licence: **CC0 1.0 Universal** (public domain dedication). Attribution is not
legally required; it is here because the work deserves it.

Used for the player and for other players' avatars
(`public/models/character.glb`). Shipped converted to GLB and compressed with
Meshopt — the original `.gltf` is 1.3 MB, the shipped file is 294 kB.

The pack also contains rigged animation clips (`Idle`, `Walk`, `Run`, `Jump`,
`Jump_Idle`, `Jump_Land`, and others) which the engine maps onto its locomotion
states.

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

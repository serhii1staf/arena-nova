import { Vector3 } from 'three';
import { gameSession } from '../net/session.ts';
import type { Engine } from '../core/Engine.ts';
import type { RelayKind } from '../net/types.ts';
import { portraitFor } from './Portraits.ts';
import { t } from './i18n.ts';

/**
 * Squad
 * -----
 * A group you can see through the world: who is in it, and how far away each of them
 * is, updated live along the top of the screen. Invitations arrive in the corner with
 * accept and decline.
 *
 * Membership is held by the clients that agreed to it, not by the server. That is a
 * real choice and worth defending: the positions needed for the distances are already
 * in the snapshot every client receives, so the only thing a server would add is a
 * second copy of who-is-with-whom — plus a rule for what happens to it when someone
 * disconnects, and a migration when the shape changes. Two clients exchanging
 * "invite" and "accept" through the relay is the whole feature.
 *
 * The honest limitation of that: the two sides can disagree if a message is lost, and
 * nothing reconciles them. In exchange, a squad survives the server knowing nothing
 * about it, and leaving is instant for both sides. Members who go offline drop out of
 * the roster on their own, because the roster is built from who is actually in the
 * room right now.
 */

interface Located {
  player?: { feetPosition: { x: number; y: number; z: number } };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/**
 * Who is in the squad, readable from outside the HUD.
 *
 * A module-level set rather than a getter on the instance, for the same reason the
 * build site is reached this way: the squad is part of the HUD and is built with it,
 * while the thing that needs to know — the crowd of remote avatars — belongs to a
 * scene that is created and destroyed around it. Neither can hold a reference to the
 * other for its whole life, and the membership is a single session-wide fact.
 */
const squadMembers = new Set<string>();

export function squadIds(): ReadonlySet<string> {
  return squadMembers;
}

/** How long an unanswered invitation stays on screen, in seconds. */
const INVITE_TIMEOUT = 25;

export class Squad {
  private readonly engine: Engine;
  private readonly roster = $('squad');
  private readonly list = $('squadList');
  private readonly invites = $('squadInvites');

  /**
   * Player ids that have agreed to be in the squad with us.
   *
   * The module-level set, not a private one: the roster on screen and the highlight
   * in the world have to be the same membership, and two sets that are meant to
   * agree eventually stop agreeing.
   */
  private readonly members = squadMembers;
  /** Open invitations we have received, by sender id. */
  private readonly pending = new Map<string, { name: string; at: number }>();
  /** Last rendered roster signature, so an unchanged frame writes nothing. */
  private signature = '';
  /** Layer the world-anchored name tags live in. */
  private readonly tags = $('squadTags');
  /** Tag element per member id, reused frame to frame. */
  private readonly shown = new Map<string, HTMLElement>();
  /** Scratch for the projection, so nothing is allocated per frame per member. */
  private readonly at = new Vector3();
  private readonly view = new Vector3();

  constructor(engine: Engine) {
    this.engine = engine;
    const net = gameSession();

    net.onRelay((from, name, kind) => this.handle(from, name, kind));
    this.wireKeys();
    // A player who leaves the room leaves the squad. Nothing to reconcile: the
    // roster is derived from who is present, so this only tidies the set.
    net.onPlayerLeave((p) => this.members.delete(p.id));
  }

  /**
   * Y accepts, N declines, oldest invitation first.
   *
   * Not a convenience. While the game holds the mouse the cursor does not exist, so
   * the pointer cannot reach the card at all — clicking it requires releasing capture
   * first, which means an invitation could only be answered by interrupting whatever
   * you were doing. The buttons stay for when the cursor is already free, on Tab or in
   * the menu, but the keyboard is the path that always works.
   */
  private wireKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return;

      // Inviting by number, only while the list is actually on screen — otherwise
      // the digit keys would be claimed globally for something you cannot see.
      if (/^Digit[1-9]$/.test(e.code) && this.engine.input.isPeeking) {
        e.preventDefault();
        this.inviteByIndex(Number(e.code.slice(5)) - 1);
        return;
      }

      if (this.pending.size === 0) return;
      if (e.code !== 'KeyY' && e.code !== 'KeyN') return;
      if (e.code === 'KeyY' && this.pending.size === 0) return;
      // Oldest first, so repeated presses work through a queue predictably.
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) return;
      e.preventDefault();
      this.answer(oldest[0], e.code === 'KeyY');
    });
  }

  /**
   * Invites by number while the player list is open: 1 is the first player under
   * your own row, 2 the second, and so on.
   *
   * The button in the list is the discoverable way in, and this is the one that
   * always works. Everything about clicking an overlay in this game is fragile —
   * the list is a pass-through layer over a canvas that hit-tests first, and the
   * pointer only exists at all while Tab is held — whereas a keypress reaches the
   * window no matter what is on top of what. The same reasoning as Y and N for
   * answering.
   */
  inviteByIndex(index: number): void {
    const others = [...gameSession().remotePlayers.values()]
      .filter((p) => !this.members.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    const pick = others[index];
    if (pick) this.invite(pick.id);
  }

  /** Invites a player by id. Called from the player list. */
  invite(id: string): void {
    if (!id || this.members.has(id)) return;
    gameSession().sendTo(id, 'squadInvite');
  }

  /** True when this player is already with us, so the list can hide the button. */
  has(id: string): boolean {
    return this.members.has(id);
  }

  private handle(from: string, name: string, kind: RelayKind): void {
    switch (kind) {
      case 'squadInvite':
        // Ignored if they are already in: a duplicate invite is not a second squad.
        if (!this.members.has(from)) {
          this.pending.set(from, { name, at: performance.now() });
          this.renderInvites();
        }
        break;
      case 'squadAccept':
        this.members.add(from);
        this.signature = '';
        break;
      case 'squadDecline':
      case 'squadLeave':
        this.members.delete(from);
        this.pending.delete(from);
        this.signature = '';
        this.renderInvites();
        break;
    }
  }

  private answer(id: string, accept: boolean): void {
    this.pending.delete(id);
    gameSession().sendTo(id, accept ? 'squadAccept' : 'squadDecline');
    if (accept) {
      this.members.add(id);
      this.signature = '';
    }
    this.renderInvites();
  }

  /** Leaves the squad, telling everyone in it. */
  leave(): void {
    for (const id of this.members) gameSession().sendTo(id, 'squadLeave');
    this.members.clear();
    this.signature = '';
  }

  private renderInvites(): void {
    if (!this.invites) return;
    const rows = [...this.pending.entries()].map(([id, info]) => {
      const card = document.createElement('div');
      card.className = 'inviteCard';

      const portrait = portraitFor(undefined);
      if (portrait) {
        const face = document.createElement('img');
        face.className = 'portrait';
        face.src = portrait;
        face.width = 30;
        face.height = 30;
        face.alt = '';
        card.append(face);
      }

      const text = document.createElement('div');
      text.className = 'inviteText';
      const who = document.createElement('strong');
      // textContent, never innerHTML: this is another player's chosen name.
      who.textContent = info.name;
      text.append(who, document.createTextNode(` ${t('squad.invites')}`));
      const keys = document.createElement('div');
      keys.className = 'inviteKeys';
      keys.textContent = t('squad.keys');
      text.append(keys);
      card.append(text);

      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'inviteBtn yes';
      yes.textContent = t('squad.accept');
      yes.addEventListener('click', () => this.answer(id, true));

      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'inviteBtn';
      no.textContent = t('squad.decline');
      no.addEventListener('click', () => this.answer(id, false));

      card.append(yes, no);
      return card;
    });
    this.invites.replaceChildren(...rows);
    this.invites.classList.toggle('on', rows.length > 0);
  }

  /** Called once per frame from the UI's overlay pass. */
  update(): void {
    // Before the empty-squad shortcut below, because leaving a squad has to take the
    // tags down with it — and that early return is exactly the path a squad of zero
    // takes. Left after it, the last member's tag stayed on screen for good.
    const located = this.engine.scenes.current as unknown as Located | null;
    this.drawTags(located?.player?.feetPosition);

    // Expire invitations nobody answered, so a card cannot sit there for a session.
    if (this.pending.size > 0) {
      const now = performance.now();
      let changed = false;
      for (const [id, info] of [...this.pending]) {
        if (now - info.at > INVITE_TIMEOUT * 1000) {
          this.pending.delete(id);
          changed = true;
        }
      }
      if (changed) this.renderInvites();
    }

    if (this.members.size === 0) {
      if (this.signature !== 'empty') {
        this.signature = 'empty';
        this.roster?.classList.remove('on');
      }
      return;
    }

    const me = located?.player?.feetPosition;
    const net = gameSession();

    // Built from who is actually in the room, so a member who disconnected simply
    // stops appearing without any bookkeeping.
    const rows: { name: string; metres: number }[] = [];
    for (const id of this.members) {
      const p = net.remotePlayers.get(id);
      if (!p) continue;
      const metres = me ? Math.round(Math.hypot(p.x - me.x, p.z - me.z)) : 0;
      rows.push({ name: p.name, metres });
    }
    rows.sort((a, b) => a.metres - b.metres);

    // Distance is rounded to whole metres, so standing still writes nothing.
    const signature = rows.map((r) => `${r.name}:${r.metres}`).join(',');
    if (signature === this.signature) return;
    this.signature = signature;

    this.roster?.classList.toggle('on', rows.length > 0);
    if (!this.list) return;
    this.list.replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement('div');
        row.className = 'squadRow';
        const name = document.createElement('span');
        name.className = 'squadName';
        name.textContent = r.name;
        const far = document.createElement('span');
        far.className = 'squadFar';
        far.textContent = `${r.metres} m`;
        row.append(name, far);
        return row;
      }),
    );
  }

  /**
   * Puts a name and a distance over each squad member's head.
   *
   * There was no world-to-screen path in this project at all — the waypoint arrow is
   * a compass bearing, not a projection — so this is the first of them. Plain HTML
   * over the canvas rather than sprites in the scene: text in the scene would be
   * tone-mapped and bloomed with everything else and would have to fight the depth
   * buffer, whereas a div is crisp at any distance and costs nothing to lay out.
   *
   * Deliberately not gated on the sight test. A tag on a teammate you *can* see is
   * still the thing you want — it tells you which of two characters is which, and how
   * far off they are. It is the body silhouette that is hidden when they are in plain
   * view, because that is what would be in the way.
   */
  private drawTags(me: { x: number; y: number; z: number } | undefined): void {
    const layer = this.tags;
    if (!layer) return;
    const camera = this.engine.scenes.current?.camera;
    if (!camera || this.members.size === 0) {
      if (layer.childElementCount > 0) layer.replaceChildren();
      this.shown.clear();
      return;
    }

    const net = gameSession();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const live = new Set<string>();

    for (const id of this.members) {
      const p = net.remotePlayers.get(id);
      if (!p) continue;

      // Just above the head, so the tag never covers the character it names.
      this.at.set(p.x, p.y + 2.15, p.z);

      // Behind the eye is checked in view space, before projecting. Projection
      // divides by w, and for a point behind the camera that flips it back into
      // frame — so a tag for somebody standing behind you would appear in front of
      // you, mirrored. The sign of the view-space depth is the only honest test.
      this.view.copy(this.at).applyMatrix4(camera.matrixWorldInverse);
      if (this.view.z > -0.6) continue;

      this.at.project(camera);
      if (Math.abs(this.at.x) > 1.15 || Math.abs(this.at.y) > 1.15) continue;

      const sx = Math.round((this.at.x * 0.5 + 0.5) * width);
      const sy = Math.round((-this.at.y * 0.5 + 0.5) * height);
      const metres = me ? Math.round(Math.hypot(p.x - me.x, p.z - me.z)) : 0;

      let tag = this.shown.get(id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'squadTag';
        const face = document.createElement('img');
        face.className = 'squadTagFace';
        face.alt = '';
        const name = document.createElement('span');
        name.className = 'squadTagName';
        const far = document.createElement('span');
        far.className = 'squadTagFar';
        tag.append(face, name, far);
        layer.appendChild(tag);
        this.shown.set(id, tag);
      }

      // Their face in the tag.
      //
      // This is what makes the highlight usable at range, and it is the part the
      // see-through body cannot do: a 1.8 m character 260 m away is about four pixels
      // tall, so however well it draws through a hill there is nothing legible to
      // look at. The portrait is the same one the player list uses — rendered once
      // per character for the session and cached — so recognising who is out there
      // costs nothing per frame.
      const face = tag.firstElementChild as HTMLImageElement;
      const portrait = portraitFor(p.skin);
      if (portrait && face.getAttribute('src') !== portrait) face.src = portrait;
      face.hidden = !portrait;

      // Text only when it changes: the position moves every frame, the name never
      // does and the distance only on whole metres.
      const name = face.nextElementSibling as HTMLElement;
      const far = tag.lastElementChild as HTMLElement;
      if (name.textContent !== p.name) name.textContent = p.name;
      const text = `${metres} m`;
      if (far.textContent !== text) far.textContent = text;
      // Faded with distance so a teammate across the valley does not shout as loudly
      // as one in the next room, but never all the way out.
      tag.style.transform = `translate(-50%, -100%) translate(${sx}px, ${sy}px)`;
      tag.style.opacity = String(Math.max(0.45, 1 - metres / 900));
      live.add(id);
    }

    // Anyone who left the squad, left the room, or walked off screen.
    for (const [id, el] of this.shown) {
      if (live.has(id)) continue;
      el.remove();
      this.shown.delete(id);
    }
  }
}

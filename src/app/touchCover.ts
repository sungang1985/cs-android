/** Which visible screens hide the touch controls (§7.2/§7.6). */

/** Screens that leave play visible and touchable underneath: the rotate gate and the non-blocking onboarding card
 *  (its steps teach the stick, Fire-R and the Buy pill, so they must stay drawn). Round end stays covering: the sim
 *  is frozen there and the scoreboard panel follows. */
const NON_COVERING: ReadonlySet<string> = new Set(['rotate', 'onboarding']);

export function touchCovered(visible: readonly string[], buyOpen: boolean): boolean {
  return buyOpen || visible.some((s) => !NON_COVERING.has(s));
}

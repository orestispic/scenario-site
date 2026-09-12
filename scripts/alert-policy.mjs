/** Pure incident reducer. Only aggregate metrics; no notification is sent here. */
export const initialAlertState = () => ({ failedProbes: 0, unhealthySince: null, opened: false, lastAt: null });
export function evaluateHealth(previous, sample) {
  if (!sample || !Number.isFinite(sample.at) || typeof sample.healthy !== 'boolean' ||
      !Number.isFinite(sample.errorRate) || sample.errorRate < 0 || sample.errorRate > 1 ||
      !Number.isSafeInteger(sample.backlog) || sample.backlog < 0 ||
      (previous.lastAt !== null && sample.at <= previous.lastAt)) throw new Error('Invalid aggregate metric');
  const degraded = !sample.healthy || sample.errorRate > 0.02 || sample.backlog > 100;
  const state = { ...previous, lastAt: sample.at, failedProbes: sample.healthy ? 0 : previous.failedProbes + 1,
    unhealthySince: degraded ? previous.unhealthySince ?? sample.at : null };
  const triggered = state.failedProbes >= 3 || (state.unhealthySince !== null && sample.at - state.unhealthySince >= 300_000);
  let transition = 'none';
  if (!state.opened && triggered) { state.opened = true; transition = 'opened'; }
  if (state.opened && !degraded) { state.opened = false; transition = 'recovered'; }
  return { state, transition };
}

export function partnerConsentReady(agreement: boolean, authority: boolean): boolean {
  return agreement === true && authority === true;
}

/**
 * The anchor of an integration's card on the Integrations page: the item sheet links to
 * `integrations#integration-<id>`, and the card scrolls itself into view when the URL names it.
 */
export function integrationAnchor(integrationId: string): string {
  return `integration-${integrationId}`;
}

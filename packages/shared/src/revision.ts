/**
 * The git revision a service image was built from.
 *
 * Baked in as `BEAM_REVISION` by the image build (a Docker build argument set
 * to the commit sha). A local or third-party build leaves it unset, which
 * reads as null rather than as a made-up value.
 */
export function beamRevision(value = process.env.BEAM_REVISION) {
  const revision = value?.trim();
  return revision && /^[0-9a-f]{7,64}$/i.test(revision)
    ? revision.toLowerCase()
    : null;
}

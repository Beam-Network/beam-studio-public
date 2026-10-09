DO $$
BEGIN
  IF to_regclass('actions.packages') IS NOT NULL
    AND to_regclass('actions.package_versions') IS NOT NULL
    AND to_regclass('actions.dist_tags') IS NOT NULL THEN
    EXECUTE $migration$
      WITH installed AS (
        SELECT DISTINCT ON (pv.package_id)
          pv.package_id,
          pv.version,
          pv.manifest_json,
          pv.provenance_json
        FROM actions.package_versions pv
        WHERE pv.provenance_json->>'source' = 'public-registry'
        ORDER BY
          pv.package_id,
          COALESCE(
            pv.provenance_json->>'installedAt',
            pv.published_at::text,
            pv.updated_at::text,
            pv.created_at::text
          ) DESC
      )
      UPDATE actions.packages package
      SET latest_version = installed.version,
          trust_level = COALESCE(
            installed.manifest_json->>'trustLevel',
            package.trust_level
          ),
          metadata_json = (package.metadata_json - 'builtin')
            || jsonb_build_object('source', 'public-registry')
            || jsonb_strip_nulls(jsonb_build_object(
              'owner', installed.manifest_json->'catalog'->>'owner',
              'maturity', installed.manifest_json->'catalog'->>'maturity',
              'tags', installed.manifest_json->'catalog'->'tags',
              'sourceRegistryUrl',
                installed.provenance_json->>'sourceRegistryUrl'
            )),
          updated_at = now()
      FROM installed
      WHERE package.id = installed.package_id
    $migration$;

    EXECUTE $migration$
      WITH installed AS (
        SELECT DISTINCT ON (pv.package_id)
          pv.package_id,
          pv.id AS version_id,
          pv.version
        FROM actions.package_versions pv
        WHERE pv.provenance_json->>'source' = 'public-registry'
        ORDER BY
          pv.package_id,
          COALESCE(
            pv.provenance_json->>'installedAt',
            pv.published_at::text,
            pv.updated_at::text,
            pv.created_at::text
          ) DESC
      )
      INSERT INTO actions.dist_tags (
        id,
        package_id,
        tag,
        version_id,
        updated_by
      )
      SELECT
        'dist-tag:' || package.package_name || ':latest',
        installed.package_id,
        'latest',
        installed.version_id,
        'public-registry'
      FROM installed
      JOIN actions.packages package ON package.id = installed.package_id
      ON CONFLICT (package_id, tag) DO UPDATE
      SET version_id = EXCLUDED.version_id,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
    $migration$;
  END IF;
END
$$;

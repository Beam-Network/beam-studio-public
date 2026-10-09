DO $$
BEGIN
  IF to_regclass('workflow.steps') IS NOT NULL THEN
    EXECUTE $migration$
      UPDATE workflow.steps
      SET config_json = config_json
        - 'apiKey'
        - 'natsUrl'
        - 'environment'
        - 'transferTemplateId'
      WHERE action_package_name = '@beam/transfer'
        AND config_json ?| ARRAY[
          'apiKey',
          'natsUrl',
          'environment',
          'transferTemplateId'
        ]
    $migration$;
  END IF;
END
$$;

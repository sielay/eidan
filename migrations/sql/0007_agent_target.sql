-- Node affinity for agents (#346): pin an agent to a specific node by EIDAN_NODE_ID. Some providers
-- only exist on some nodes (e.g. free local ollama lives on the Pi), so an ollama agent must run there.
-- null = any capable node may claim the fire (the default).
alter table eidan.agents add column if not exists target_node text;

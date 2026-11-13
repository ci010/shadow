import type { LayerFSImportPolicy, LayerFSNameClassification } from './import-review.ts'
export function classifyLayerFSName(name: string, directory = false, policy: LayerFSImportPolicy = 'curated', credentialAncestor = false, gitAncestor = false): LayerFSNameClassification {
  const n = name.toLowerCase()
  if (n === '.git') return directory
    ? { warning: 'git_metadata_requires_content_review' }
    : { blocker: 'unsupported_git_file_topology_external_metadata_not_imported' }
  if (!gitAncestor && (!credentialAncestor || directory) && ['.hg', '.svn', '.venv', 'venv', 'node_modules', 'vendor', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'dist', 'build'].includes(n)) return policy === 'curated'
    ? { blocker: 'outside_curated_scope_use_whole_tree_or_separate_baseline' }
    : { warning: 'repository_dependency_or_build_data_requires_content_review' }
  if (n.startsWith('.env') && !['.env.example', '.env.sample'].includes(n)) return { blocker: 'environment_configuration' }
  if (['bot.config.json', '.shadow', '.credentials', '.secrets', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.dockercfg', 'gcloud', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', '.pgpass'].includes(n)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(n)
    || /\.(?:pem|key|p12|pfx|ppk|pkcs8|keytab|keystore|jks)$/.test(n)) return { blocker: 'possible_credentials_or_private_key' }
  const heuristic = /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/.test(n) || /(?:private[._-]?key|service[._-]?account)/.test(n)
  if (!heuristic && !credentialAncestor) return {}
  // Code, tests, documentation and visual assets often discuss credentials. Their
  // names warrant content review, not a claim that they contain credentials.
  const reviewable = /\.(?:[cm]?[jt]sx?|vue|svelte|py|pyi|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|swift|sh|ps1|sql|md|mdx|rst|adoc|html?|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|snap)$/.test(n)
  const configuration = /\.(?:json|jsonc|ya?ml|toml|ini|conf|config|xml|properties|env)$/.test(n)
    || /^\.?(?:credentials?|secrets?)(?:\.(?:txt|csv|tsv|bak|log))?$/.test(n)
    || /^(?:private[._-]?key|service[._-]?account)\.txt$/.test(n)
  if (!directory && !reviewable && (configuration || credentialAncestor)) return { blocker: 'possible_credentials_or_private_key' }
  return { warning: 'credential_related_name_requires_content_review' }
}

/**
 * Infrastructure fitment guide for the Pattern Library page (Wave 13) - reference
 * writing for consultants choosing on-premises compute and storage.
 *
 * Stack ids and labels mirror `onPremStacks` in backend/config/infrastructure-targets.yaml
 * (the backend test platform-config.service.spec checks that every pattern only names
 * ids defined there). Like that catalogue this is DIRECTIONAL: confirm current models,
 * NVIDIA certifications, support terms and pricing with each vendor.
 */

export interface StackProfile {
  id: string;
  label: string;
  vendors: string;
  bestFor: string;
  gpuRange: string;
  strengths: string[];
  watchOuts: string[];
  cloudExtension: string;
  support: string;
}

export const STACK_PROFILES: StackProfile[] = [
  {
    id: 'nutanix_hci',
    label: 'Nutanix HCI + Nutanix Unified Storage',
    vendors: 'Nutanix (NX or OEM nodes such as Dell XC)',
    bestFor: 'Inference-only RAG at small to mid scale, branch / edge sites, VMware exits, small operations teams',
    gpuRange: 'Up to ~16 GPUs comfortably, ~32 at most',
    strengths: ['One platform for compute, storage, VMs and Kubernetes (NKP) - simplest to run', 'Nutanix Enterprise AI gives a ready model-serving layer', 'Block, file and object from one cluster; NearSync / Metro replication'],
    watchOuts: ['Not built for multi-node training or very high storage throughput', 'GPU density per node is lower than dedicated GPU servers'],
    cloudExtension: 'Nutanix Cloud Clusters (NC2) on Azure and AWS',
    support: 'One vendor for software and NX hardware; Pulse call-home telemetry',
  },
  {
    id: 'dell_powerscale',
    label: 'Dell PowerEdge XE + PowerScale / PowerStore (Dell AI Factory)',
    vendors: 'Dell Technologies (incl. the former EMC storage line)',
    bestFor: 'Enterprise RAG and fine-tuning where one vendor should own compute and storage',
    gpuRange: '8 to a few hundred GPUs',
    strengths: ['Single support contract for GPU servers and storage', 'PowerScale scale-out NAS with NFS over RDMA and GPUDirect; SuperPOD-certified configurations', 'PowerStore NVMe block for vector databases; SmartLock WORM for regulated data'],
    watchOuts: ['Needs a dedicated infrastructure team', 'Oversized for a handful of GPUs'],
    cloudExtension: 'APEX File Storage (OneFS) on Azure and AWS',
    support: 'Dell ProSupport end to end; CloudIQ / APEX AIOps telemetry',
  },
  {
    id: 'dell_netapp',
    label: 'Dell PowerEdge XE + NetApp ONTAP AFF (AIPod)',
    vendors: 'Dell (compute) + NetApp (storage)',
    bestFor: 'Hybrid enterprise RAG on an existing NetApp estate, with DR or bursting to Azure / AWS / GCP',
    gpuRange: 'Any size up to ~64 GPUs comfortably; more with scale-out',
    strengths: ['ONTAP gives block, file and S3 in one OS - index documents where they already live', 'SnapMirror (sync / async), MetroCluster, tamper-proof snapshots, SnapLock WORM', 'Same storage OS in all three big clouds - the strongest hybrid / DR story'],
    watchOuts: ['Two vendors to coordinate - agree who triages', 'No parallel file system for very large training'],
    cloudExtension: 'Azure NetApp Files, Amazon FSx for NetApp ONTAP, Google Cloud NetApp Volumes',
    support: 'Dell ProSupport + NetApp SupportEdge under the NVIDIA-validated AIPod design; Active IQ telemetry',
  },
  {
    id: 'dell_vast',
    label: 'Dell PowerEdge XE + VAST Data',
    vendors: 'Dell (compute) + VAST Data (storage)',
    bestFor: 'Large GPU estates that want one data platform for training, inference and RAG',
    gpuRange: '16 to thousands of GPUs',
    strengths: ['All-flash, multi-protocol (NFS, S3, block) on one namespace', 'Very high throughput with GPUDirect; SuperPOD-certified', 'Simple to operate for its scale'],
    watchOuts: ['Oversized and costly for small inference-only projects', 'Native replication is asynchronous - check the RPO'],
    cloudExtension: 'VAST on Cloud marketplaces (AWS, Azure, GCP)',
    support: 'Dell ProSupport + VAST support; VAST Uplink call-home',
  },
  {
    id: 'dell_ddn',
    label: 'Dell PowerEdge XE + DDN EXAScaler (A3I)',
    vendors: 'Dell (compute) + DDN (storage)',
    bestFor: 'Training and checkpoint-heavy work on large GPU clusters where throughput matters most',
    gpuRange: '32 to thousands of GPUs',
    strengths: ['Lustre parallel file system - top throughput for training and checkpoints', 'SuperPOD-certified; long HPC track record'],
    watchOuts: ['Needs an HPC / platform team', 'No block tier - vector databases go on local NVMe', 'Overkill for inference-only RAG'],
    cloudExtension: 'Azure Managed Lustre and Google Cloud Managed Lustre (DDN-based)',
    support: 'Dell ProSupport + DDN support; DDN Insight monitoring',
  },
];

export const stackLabel = (id: string) => STACK_PROFILES.find((s) => s.id === id)?.label ?? id;

export const DECISION_STEPS: Array<{ title: string; ask: string; guidance: string[] }> = [
  {
    title: 'Cloud, on-premises or hybrid?',
    ask: 'Where may the data and the models run?',
    guidance: [
      'Restricted data (PHI, client financial records, defence), sovereignty or a regulator that rules out a provider → on-premises or a sovereign cloud.',
      'Very spiky or seasonal traffic, no data restriction and a small team → cloud first; elasticity is cheaper than buying for peak.',
      'Data already on a storage platform that also runs in the cloud (e.g. ONTAP) → hybrid is natural: run on-premises, replicate to the cloud for DR or burst.',
    ],
  },
  {
    title: 'How big is the GPU footprint?',
    ask: 'GPUs at peak from the Inference Assessment (not a guess).',
    guidance: [
      'Up to ~16 GPUs → HCI (Nutanix) or a modest Dell + NetApp / PowerScale build.',
      '16-64 GPUs → Dell PowerEdge XE with NetApp ONTAP or PowerScale.',
      '64+ GPUs, or a planned AI factory → Dell XE with VAST Data, PowerScale or DDN.',
      'CPU-only (vector search, no self-hosted model) → storage choice matters more than compute; HCI or existing estate usually wins.',
    ],
  },
  {
    title: 'Inference only, or training too?',
    ask: 'Will the customer fully fine-tune or train models on-premises?',
    guidance: [
      'Inference and adapter (LoRA) tuning → any stack; weights load from shared file storage.',
      'Full fine-tuning or training → a stack built for parallel throughput and checkpoints: PowerScale, VAST Data or DDN. HCI is not the right fit.',
    ],
  },
  {
    title: 'What does the customer already run?',
    ask: 'Storage vendor, hypervisor, skills and support contracts in place today.',
    guidance: [
      'Existing NetApp → Dell + NetApp; existing Dell / EMC → Dell PowerScale / PowerStore; existing Nutanix → Nutanix HCI.',
      'VMware estate looking for an exit → Nutanix (AHV) is a common landing zone; plan the migration.',
      'Reuse lowers risk: the team already knows the tooling, backup and support processes.',
    ],
  },
  {
    title: 'Who will run it, and how is it protected?',
    ask: 'Ops capability, RPO / RTO, second site, DR target.',
    guidance: [
      'Part-time IT → HCI or a vendor / partner managed service. Dedicated infrastructure team → Dell + NetApp / PowerScale / VAST. HPC team → DDN.',
      'RPO near zero → synchronous replication (NetApp SnapMirror Sync / MetroCluster, PowerStore Metro, Nutanix Metro).',
      'DR to a cloud → pick a stack whose storage OS also runs in that cloud.',
    ],
  },
];

export const QUICK_MATRIX: Array<{ situation: string; first: string; alternative: string; why: string }> = [
  { situation: 'Small inference-only RAG, part-time IT', first: 'nutanix_hci', alternative: 'dell_netapp', why: 'Simplest platform; enough GPUs for a mid-size model' },
  { situation: 'Enterprise RAG, NetApp already in place, Azure DR', first: 'dell_netapp', alternative: 'dell_powerscale', why: 'Reuse ONTAP; SnapMirror to Azure NetApp Files' },
  { situation: 'Enterprise RAG, Dell / EMC estate, one vendor wanted', first: 'dell_powerscale', alternative: 'dell_netapp', why: 'Single Dell support contract for compute and storage' },
  { situation: 'Regulated data with WORM retention', first: 'dell_netapp', alternative: 'dell_powerscale', why: 'SnapLock / SmartLock and synchronous replication' },
  { situation: 'Large GPU estate, training + inference + RAG', first: 'dell_vast', alternative: 'dell_powerscale', why: 'One high-throughput platform for every data type' },
  { situation: 'Training-heavy, HPC team, max throughput', first: 'dell_ddn', alternative: 'dell_vast', why: 'Lustre parallel file system built for checkpoints' },
  { situation: 'Many edge sites plus a central data lake', first: 'nutanix_hci', alternative: 'dell_powerscale', why: 'HCI at the edge, scale-out file / object in the core' },
];

export const STORAGE_TIERS: Array<{ tier: string; holds: string; matters: string }> = [
  { tier: 'Block (NVMe)', holds: 'Vector database data and indexes', matters: 'Low latency and IOPS; snapshots; synchronous replication for low RPO. Not NAS.' },
  { tier: 'File (shared)', holds: 'Model weights, serving artefacts, source documents', matters: 'Throughput so every GPU node loads the same model fast (NFS over RDMA, GPUDirect). Sets recovery and scale-out time.' },
  { tier: 'Object (S3)', holds: 'Document archive, backups, model registry, logs, traces', matters: 'Cheap capacity, immutability (WORM) and lifecycle tiering.' },
  { tier: 'Parallel file system', holds: 'Training data and checkpoints', matters: 'Aggregate throughput at scale. Only needed for full fine-tuning or training.' },
];

export const CUSTOMER_QUESTIONS: string[] = [
  'Which storage platforms and hypervisor run today, and when do their contracts or support end?',
  'Is any data restricted (PHI, PCI, client records) or bound to a country or region?',
  'How many GPUs at peak (from the Inference Assessment), and are GPUs already on-premises?',
  'Will models be fully fine-tuned or trained on-premises, or only served?',
  'What availability, RPO and RTO are required, and is there a second site or a cloud DR target?',
  'Who will operate the platform: part-time IT, a dedicated infrastructure team, or an HPC / platform team?',
  'How fast does the corpus grow, and how long must source data, prompts and outputs be kept?',
  'Is there a preferred hardware vendor or procurement framework, and what is the GPU lead time?',
];

export const SUPPORT_GUIDANCE: string[] = [
  'Prefer one throat to choke where the team is small: Nutanix (software + NX hardware) or Dell end to end (PowerEdge + PowerScale / PowerStore).',
  'With two vendors (Dell + NetApp / VAST / DDN), write down who triages first - the customer, the partner or a co-operative support agreement - before go-live.',
  'Register vendor telemetry (Nutanix Pulse, Dell CloudIQ / APEX AIOps, NetApp Active IQ, VAST Uplink, DDN Insight) so cases open from health signals, not outages.',
  'Keep firmware, GPU drivers, CUDA and NVIDIA AI Enterprise on the vendor-validated matrix; NVIDIA-validated designs (AIPod, Dell AI Factory, SuperPOD) shorten escalations.',
  'Run a DR drill from storage snapshots / replication and record the achieved RPO / RTO in the Operations Model.',
];

import type { Model, PostKind, User } from '@zhidedeng/shared';
import { Store } from './database.ts';

const catalog = [
  ['openai', 'OpenAI', [['gpt-4-1', 'GPT-4.1'], ['gpt-4-1-mini', 'GPT-4.1 mini'], ['o3', 'o3']]],
  ['anthropic', 'Anthropic', [['claude-sonnet', 'Claude Sonnet'], ['claude-opus', 'Claude Opus'], ['claude-haiku', 'Claude Haiku']]],
  ['google', 'Google', [['gemini-pro', 'Gemini Pro'], ['gemini-flash', 'Gemini Flash'], ['gemini-flash-lite', 'Gemini Flash Lite']]],
  ['deepseek', 'DeepSeek', [['deepseek-chat', 'DeepSeek Chat'], ['deepseek-reasoner', 'DeepSeek Reasoner'], ['deepseek-coder', 'DeepSeek Coder']]],
  ['xai', 'xAI', [['grok', 'Grok'], ['grok-mini', 'Grok mini'], ['grok-code', 'Grok Code']]],
  ['meta', 'Meta', [['llama', 'Llama'], ['llama-scout', 'Llama Scout'], ['llama-maverick', 'Llama Maverick']]],
  ['qwen', '阿里通义', [['qwen-plus', 'Qwen Plus'], ['qwen-turbo', 'Qwen Turbo'], ['qwen-max', 'Qwen Max']]],
  ['doubao', '字节豆包', [['doubao-pro', 'Doubao Pro'], ['doubao-lite', 'Doubao Lite'], ['doubao-seed', 'Doubao Seed']]],
  ['moonshot', '月之暗面', [['kimi', 'Kimi'], ['kimi-thinking', 'Kimi Thinking'], ['moonshot', 'Moonshot']]],
  ['zhipu', '智谱AI', [['glm', 'GLM'], ['glm-flash', 'GLM Flash'], ['glm-air', 'GLM Air']]],
  ['minimax', 'MiniMax', [['minimax-m', 'MiniMax M'], ['minimax-text', 'MiniMax Text'], ['minimax-lightning', 'MiniMax Lightning']]],
] as const;

const stationNames = [
  ['dengdeng-demo', '蹬蹬云'], ['whale-demo', '大肥鱼试验站'], ['lime-demo', '青柠蹬蹬API'],
  ['orange-demo', '橘子脚踏快线'], ['cloudshoe-demo', '云朵拖鞋API'], ['radish-demo', '萝卜月球中转'],
  ['snail-demo', '蜗牛加速舱'], ['cookie-demo', '曲奇试蹬台'], ['lantern-demo', '灯笼猫网关'],
  ['pudding-demo', '布丁星环API'], ['mint-demo', '薄荷小火箭'], ['compass-demo', '指南针纸船'],
] as const;

const users: User[] = [
  { handle: 'demo-pedal', nickname: '虚构踏板', bio: '先小额测试，再决定要不要长期用。' },
  { handle: 'demo-rice', nickname: '虚构饭团', bio: '只记录演示站的晚高峰体验。' },
  { handle: 'demo-moon', nickname: '虚构月亮', bio: '关心模型一致性和退款条款。' },
  { handle: 'demo-wood', nickname: '虚构木匠', bio: '写代码也爱记测试笔记。' },
  { handle: 'demo-cat', nickname: '虚构猫掌', bio: '把账单里的坑一个个写清楚。' },
  { handle: 'demo-bike', nickname: '虚构单车', bio: '中转站新手的试蹬日记。' },
  { handle: 'demo-tea', nickname: '虚构茶杯', bio: '偶尔画图，偶尔调接口。' },
  { handle: 'demo-sand', nickname: '虚构沙粒', bio: '从错误码里找线索。' },
].map((user, index) => ({ ...user, avatar: '', tokens: 120 + index * 35 }));

const topics = [
  ['小额试用比一次充满更安心', '充值前我先跑了三类请求：短问答、长上下文和流式输出。倍率漂亮只能说明一部分，失败请求是否计费也要查。', '先看最低充值门槛，再看余额有效期。我的做法是把预算拆成几次，第一轮只验证自己真正需要的模型。'],
  ['晚高峰到底稳不稳，我连测了三天', '白天试用顺畅，晚上却可能排队。这里记录的是虚构站的演示样本，不能拿一次成功代替长期观察。', '同一组提示词分早中晚执行，记录首 token 延迟、错误率和完整响应时间。超时要保留 request id，方便与支持人员核对。'],
  ['低倍率背后，还要看清这些限制', '页面上的最低倍率对应特定模型，不一定适用于长上下文、缓存写入和高并发。下单前值得把使用条件问完整。', '我把自己的请求清单写下来，再逐项核对倍率表。不要用一个模型的最低倍率推断整个站的成本，更别忽略限速条件。'],
  ['第一次配 API，先把这张清单过一遍', 'Base URL、模型名、流式选项和超时参数都确认以后，再开始正式调用。密钥只保存在服务端环境变量中。', '先用最短的文本请求确认连通，再开流式，最后测试工具调用。报错时先核对模型是否被收录，别把密钥贴进公开讨论区。'],
  ['别只问能不能用，先问怎么退', '我试着读了一遍充值和退款说明，发现是否支持未消费余额退款，比一次优惠更值得关注。演示站条款仅作阅读练习。', '保留订单、计费记录和客服回复。看清退款时限、扣费口径和到账方式；遇到含糊的描述，先暂停充值。'],
  ['同一个模型名，体验为什么不一样', '我拿相同输入比较了输出长度、工具调用和上下文处理。不同时间的结果有波动，不能仅凭语气判断模型真伪。', '用可重复任务做对比，记录参数和测试时间。模型自报身份并不是可靠证据，应该结合功能支持、错误结构和路由说明一起看。'],
  ['流式响应测完了，这个细节别漏', '普通请求成功以后，我又测了中断、断线和重试。能返回首字不代表整个长回答都能稳定收尾。', '检查 SSE 结束标记、客户端主动取消和网络断连后的计费。重试前先确认请求是否已完成，避免重复扣费。'],
  ['给团队采购前，我先做了配额隔离', '团队共用一个大 key 很难定位消耗。我在虚构站演练了按项目分 key，再给每个 key 设预算。', '测试子密钥能否限制模型、限制额度并随时撤销。账单要能对应到项目，人员离开时也要及时回收密钥。'],
  ['缓存倍率省不省，拿自己的输入算', '宣传里的缓存命中率和我的实际任务差很多。固定系统提示词有机会复用，但频繁变化的输入未必划算。', '分别记录缓存命中与未命中的请求，按自己的任务占比估算相对成本。这里只比较倍率，不提供官方绝对价格。'],
  ['长上下文别一上来就塞满', '我先从小文档开始测，逐步增加长度，确认截断、超时和返回内容。只看成功状态码容易漏掉信息缺失。', '在文本首尾放可核验的问题，观察输出是否覆盖。保留输入长度和输出限制，给长任务设置合理超时。'],
  ['看懂状态页，比盯着优惠更有用', '站点状态、维护公告和历史故障记录能帮助理解波动。演示站的可用率只是样例，不能当作真实承诺。', '对自己关键业务设置可用性探测，区分鉴权失败、配额耗尽与上游故障。需要切换时，事先演练备用路由。'],
  ['新手避坑：截图不能代替自己的测试', '别人的测速截图只反映某个时间点。选中转站还是要按自己的模型、地区和请求模式做一轮小规模验证。', '把测试步骤写下来，隔几天再复测。遇到无条件稳定、永久最低这类话术，我会多问一句证据在哪里。'],
] as const;

export function seed(store: Store, now: Date) {
  store.transaction(() => {
    if (store.all('vendor').length === 0) writeSeed(store, now);
  });
}

function writeSeed(store: Store, now: Date) {
  const models: Model[] = [];
  for (const [slug, name, entries] of catalog) {
    store.put('vendor', slug, { slug, name, iconKey: slug });
    entries.forEach(([modelSlug, modelName], index) => {
      const model: Model = { slug: modelSlug, vendor: slug, name: modelName, description: `${name} 旗下的${index === 0 ? '通用对话与创作' : index === 1 ? '高效日常任务' : '推理与开发任务'}模型，收录信息用于分类展示。`, tags: index === 0 ? ['热门', '文本'] : index === 1 ? ['轻量', '高效'] : ['推理', '开发'] };
      models.push(model);
      store.put('model', model.slug, model);
    });
  }
  users.forEach(user => store.put('user', user.handle, user));
  stationNames.forEach(([slug, name], index) => {
    store.put('station', slug, {
      slug, name: `虚构·${name}`, description: `${name} 是虚构中转站演示样例，提供模型倍率对比与试用记录，不代表真实服务或消费建议。`,
      rechargeThreshold: [5, 10, 20, 30][index % 4], paymentMethods: index % 2 ? ['支付宝'] : ['支付宝', '微信支付'],
      uptime: Number((97.4 + (index * 7 % 25) / 10).toFixed(1)), firstTokenLatencyMs: 260 + index * 73,
      foundedAt: `2025-${String(index + 1).padStart(2, '0')}-08`, status: index % 5 === 4 ? 'unstable' : 'running',
      url: null, source: 'demo',
    });
    for (let offerIndex = 0; offerIndex < 6 + index % 10; offerIndex++) {
      const model = models[(index * 3 + offerIndex * 5) % models.length];
      store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)')
        .run(slug, model.slug, Number((0.35 + ((index * 11 + offerIndex * 7) % 80) / 100).toFixed(2)));
    }
  });
  for (let index = 0; index < 48; index++) {
    // post-1 是 Banner 主推的大肥鱼评测，固定关联大肥鱼试验站与 DeepSeek。
    const [stationSlug, stationName] = stationNames[index === 0 ? 1 : index % stationNames.length];
    const model = index === 0 ? models.find(item => item.vendor === 'deepseek')! : models[index % models.length];
    const [title, summary, advice] = topics[Math.floor(index / 4)];
    const kind: PostKind = (['review', 'deal', 'community', 'guide'] as const)[index % 4];
    const id = `post-${index + 1}`;
    const publishedAt = new Date(now.getTime() - index * 14.5 * 3600000).toISOString();
    store.put('post', id, {
      id, kind, title: index === 0 ? '4.1pro新版 大肥鱼评测：虚构站的小额试用笔记' : `${stationName} · ${title}`,
      summary: `${stationName} 虚构体验：${summary}`, body: `# ${stationName} 的试蹬记录\n\n> 本文所有站点与体验均为虚构演示，不构成消费建议。\n\n${summary}\n\n## 我是怎么测的\n\n我用 ${model.name} 跑了自己的日常任务，先保留默认参数，再记录一次流式响应。${advice}\n\n## 这次的取舍\n\n${kind === 'deal' ? '看见倍率活动也别急着充值，先确认适用模型和有效时间。' : kind === 'review' ? '我更看重错误时能否追踪、账单能否对上，最低倍率只是参考的一项。' : kind === 'community' ? '大家如果在演示环境做过同类测试，可以分享方法和注意点，别公开密钥。' : '建议按这份步骤逐项记录，保留可复查的证据，再决定是否继续试用。'}\n\n所有倍率、延迟与可用率均是示例，不对应任何真实中转服务。`,
      authorHandle: users[index % users.length].handle, stationSlug,
      modelSlug: model.slug, cover: null, publishedAt, source: 'demo', status: 'approved',
    });
    for (let userIndex = 1; userIndex <= 1 + index % 7; userIndex++) {
      store.db.prepare('INSERT INTO votes (userHandle,targetType,targetId,value) VALUES (?,?,?,?)')
        .run(users[userIndex].handle, 'post', id, (index + userIndex) % 4 === 0 ? 'down' : 'up');
    }
    if (index % 3 === 0) store.db.prepare('INSERT INTO favorites (userHandle,targetType,targetId,createdAt) VALUES (?,?,?,?)').run('demo-pedal', 'post', id, publishedAt);
    for (let commentIndex = 0; commentIndex < index % 4; commentIndex++) {
      store.db.prepare('INSERT INTO comments (id,userHandle,targetType,targetId,content,parentId,createdAt) VALUES (?,?,?,?,?,?,?)')
        .run(`seed-${index}-${commentIndex}`, users[(index + commentIndex) % users.length].handle, 'post', id,
          ['这份虚构测试记录挺细，我会先测晚高峰再看倍率。', '建议补上流式断线的计费观察，别一次充太多。', '模型名只是分类，实际可用情况还得自己验证。'][commentIndex], null, publishedAt);
    }
  }
  stationNames.forEach(([slug], index) => {
    for (let userIndex = 0; userIndex <= index % 8; userIndex++) {
      store.db.prepare('INSERT INTO votes (userHandle,targetType,targetId,value) VALUES (?,?,?,?)')
        .run(users[userIndex].handle, 'station', slug, (index + userIndex) % 3 === 0 ? 'down' : 'up');
    }
    store.db.prepare('INSERT INTO favorites (userHandle,targetType,targetId,createdAt) VALUES (?,?,?,?)').run(users[index % 8].handle, 'station', slug, now.toISOString());
    store.db.prepare('INSERT INTO comments (id,userHandle,targetType,targetId,content,parentId,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(`station-comment-${index}`, users[(index + 1) % 8].handle, 'station', slug, '虚构样例：先看退款说明，再用自己的请求小额测试。', null, now.toISOString());
  });
  const banners = [
    { id: 'whale', title: '4.1pro新版 大肥鱼评测', description: 'DeepSeek · 大肥鱼', image: '/banners/whale.webp', href: '/posts/post-1' },
    { id: 'pedal', title: '小额试蹬，选站有章法', description: '先测稳定，再看倍率', image: '/banners/pedal.webp', href: '/posts/post-4' },
    { id: 'compass', title: '给你的 API 选一条明路', description: '模型倍率，一起比较', image: '/banners/compass.webp', href: '/stations' },
  ];
  banners.forEach(banner => store.put('banner', banner.id, banner));
}

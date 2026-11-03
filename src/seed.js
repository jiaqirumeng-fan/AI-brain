/* 海马体 · 示例知识网络
   一位大二学生一个学期之后「脑内」的样子：
   最近在做的项目最亮，半年前学的电磁感应几乎只剩一道痕迹。 */
(function (global) {
  'use strict';

  const HU = global.HU;
  const Model = global.Model;
  const DAY = HU.DAY;

  const DOMAINS = [
    { id: 'math', name: '高等数学', color: '#4cc9f0' },
    { id: 'linalg', name: '线性代数', color: '#8b7bff' },
    { id: 'physics', name: '大学物理', color: '#ffa94d' },
    { id: 'cs', name: '计算机 · AI', color: '#2fe6a8' },
    { id: 'project', name: '项目 · 竞赛', color: '#ff6b9a' },
    { id: 'learning', name: '学习科学', color: '#ffd166' }
  ];

  /* key, 标题, 领域, 摘要, 标签, 重要度, 距上次调用(天), 调用次数 */
  const NODES = [
    ['deriv', '导数与变化率', 'math',
      '函数在某一点的瞬时变化率：把平均速度取极限，就得到瞬时速度。它是所有优化与建模的起点。',
      ['导数', '极限', '变化率', '切线'], 0.85, 6, 5],
    ['integral', '积分与累积', 'math',
      '把无限多个微小量累加成整体：面积、做功、概率密度都可以用积分统一描述。',
      ['积分', '累积', '微元', '面积'], 0.75, 21, 2],
    ['taylor', '泰勒展开', 'math',
      '用多项式在局部逼近函数，阶数越高越贴近；工程上常取一阶做线性化。',
      ['泰勒', '近似', '多项式', '线性化'], 0.7, 38, 1],
    ['fourier', '傅里叶变换', 'math',
      '把信号拆成不同频率的正弦波；时域看不清的结构，换到频域就一目了然。',
      ['傅里叶', '频域', '正弦', '信号'], 0.8, 96, 1],
    ['bayes', '概率与贝叶斯', 'math',
      '用先验与似然更新后验。面对不确定信息时，它给出「如何改变看法」的公式。',
      ['概率', '贝叶斯', '先验', '似然'], 0.8, 14, 3],
    ['grad', '梯度与方向导数', 'math',
      '多元函数增长最快的方向；梯度指向最陡上升，它的反方向就是下降。',
      ['梯度', '方向导数', '最优化', '多元函数'], 0.9, 3, 6],
    ['ode', '微分方程', 'math',
      '用变化率描述系统演化：人口、电路、传染病都能写成一个微分方程。',
      ['微分方程', '建模', '演化', '指数衰减'], 0.72, 55, 0],

    ['matrix', '矩阵与线性变换', 'linalg',
      '矩阵是空间的线性变换：旋转、缩放、投影都能写成一次矩阵乘法。',
      ['矩阵', '线性变换', '基', '空间'], 0.85, 8, 4],
    ['eigen', '特征值与特征向量', 'linalg',
      '变换中方向不变、只被伸缩的向量；特征值就是伸缩倍数，揭示系统的固有模态。',
      ['特征值', '特征向量', '模态', '对角化'], 0.8, 30, 2],
    ['svd', '奇异值分解', 'linalg',
      '任意矩阵都能分解为「旋转—伸缩—旋转」；取前几个奇异值就是最优降维。',
      ['SVD', '分解', '降维', '秩'], 0.68, 72, 1],
    ['span', '向量空间与基', 'linalg',
      '一组向量能张成多大的空间；换一组基，就是换一套描述世界的坐标。',
      ['向量空间', '基', '维度', '张成'], 0.65, 44, 1],
    ['lsq', '最小二乘', 'linalg',
      '方程无解时，找误差平方和最小的近似解；几何上就是把点投影到子空间。',
      ['最小二乘', '拟合', '投影', '误差'], 0.75, 26, 2],

    ['newton', '牛顿定律', 'physics',
      '力改变运动状态，F = ma 把因果写成了可计算的等式。',
      ['力', '加速度', '惯性', '运动'], 0.8, 40, 2],
    ['energy', '能量守恒', 'physics',
      '能量在形式之间转化但总量不变；很多难题用能量法可以绕开复杂的受力分析。',
      ['能量', '守恒', '做功', '势能'], 0.78, 17, 3],
    ['shm', '简谐振动', 'physics',
      '回复力与位移成正比时，系统按正弦规律往复；频率由系统自身决定。',
      ['振动', '正弦', '周期', '频率'], 0.72, 62, 1],
    ['induction', '电磁感应', 'physics',
      '变化的磁场产生电场；法拉第定律把「变化」直接变成了电压。',
      ['电磁感应', '法拉第', '磁通', '楞次'], 0.7, 88, 0],
    ['wave', '波动与叠加', 'physics',
      '波相遇时位移相加，形成干涉与驻波：同相增强，反相抵消。',
      ['波', '干涉', '叠加', '相位'], 0.68, 49, 1],
    ['heat', '热力学第二定律', 'physics',
      '孤立系统的熵不会减少；它给时间一个方向，也给效率划出上限。',
      ['熵', '热力学', '不可逆', '效率'], 0.66, 110, 0],

    ['gd', '梯度下降', 'cs',
      '沿着梯度的反方向小步走，逐步降低损失；学习率决定每一步迈多大。',
      ['梯度', '优化', '迭代', '学习率'], 0.92, 2, 7],
    ['nn', '神经网络与反向传播', 'cs',
      '多层非线性变换堆叠成函数逼近器；反向传播用链式法则把误差分摊回每个参数。',
      ['神经网络', '反向传播', '链式法则', '参数'], 0.9, 5, 5],
    ['cnn', '卷积神经网络', 'cs',
      '用局部感受野和权重共享提取图像特征：浅层看边缘，深层看物体。',
      ['卷积', '图像', '特征提取', '权重共享'], 0.82, 19, 3],
    ['overfit', '监督学习与过拟合', 'cs',
      '模型在训练集上越来越好，在没见过的数据上却变差；正则化与更多数据是对策。',
      ['监督学习', '泛化', '正则化', '过拟合'], 0.76, 33, 2],
    ['bigo', '时间复杂度', 'cs',
      '描述输入规模增大时运算量的增长阶；它关心趋势，不关心常数。',
      ['复杂度', '算法', '渐进', '大O'], 0.6, 58, 1],
    ['graph', '图结构', 'cs',
      '用节点和边描述关系；社交网络、知识图谱、路线规划都是图。',
      ['图', '节点', '边', '遍历'], 0.7, 12, 3],
    ['infent', '信息熵', 'cs',
      '不确定性的度量；熵越大，信息越难压缩，也越「意外」。',
      ['熵', '信息量', '编码', '不确定性'], 0.74, 47, 1],

    ['wrongbook', '智能错题本', 'project',
      '拍照入库错题，按知识点自动归类，并用遗忘曲线安排重做。',
      ['错题', '知识图谱', '推荐', '拍照'], 0.9, 1, 6],
    ['ocr', '手写公式识别', 'project',
      '把纸上的公式转成 LaTeX；难点是笔迹多样与结构歧义。',
      ['OCR', '公式', '手写', 'LaTeX'], 0.84, 9, 4],
    ['caption', '课堂实时字幕', 'project',
      '手机听课后实时转写并分段；低延迟与专业词纠错是核心。',
      ['语音识别', '字幕', '实时', '降噪'], 0.8, 23, 2],
    ['review', '记忆曲线复习计划', 'project',
      '按每个知识点的稳定度安排复习，而不是统一「明天再看」。',
      ['间隔重复', '遗忘曲线', '复习', '调度'], 0.86, 4, 5],
    ['sync', '跨设备笔记同步', 'project',
      '手机拍、平板写、电脑存；离线修改需要冲突合并策略。',
      ['同步', '离线', '冲突', 'CRDT'], 0.7, 65, 1],
    ['pitch', '竞赛答辩叙事', 'project',
      '把技术翻译成评委听得懂的价值：问题、洞察、证据、边界。',
      ['演示', '叙事', '价值', '答辩'], 0.75, 36, 1],

    ['ebbing', '艾宾浩斯遗忘曲线', 'learning',
      '保持率随时间近似指数衰减；刚学完下降最快，之后逐渐趋缓。',
      ['遗忘曲线', '指数衰减', '保持率', '记忆'], 0.85, 28, 3],
    ['spacing', '间隔重复', 'learning',
      '把复习分散到逐渐拉长的间隔；每次成功提取都会提高记忆稳定度。',
      ['间隔', '复习', '稳定度', '调度'], 0.88, 7, 4],
    ['retrieval', '检索练习', 'learning',
      '主动回想比反复阅读更有效，「提取」这个动作本身就在加固记忆。',
      ['主动回忆', '提取', '测试效应', '练习'], 0.87, 11, 4],
    ['load', '认知负荷', 'learning',
      '工作记忆容量有限；分块与减少无关信息能让学习更顺畅。',
      ['工作记忆', '分块', '负荷', '注意力'], 0.7, 52, 1],
    ['transfer', '学习迁移', 'learning',
      '把一个情境里学到的结构用到另一个情境；类比与共同抽象是关键。',
      ['迁移', '类比', '抽象', '跨域'], 0.8, 16, 3]
  ];

  /* a, b, 权重, 连接理由 —— 跨领域的边就是「全局思维」的桥 */
  const LINKS = [
    ['deriv', 'integral', 0.55, '微积分基本定理把两者接在一起'],
    ['deriv', 'taylor', 0.5, '用导数构造局部近似'],
    ['deriv', 'grad', 0.78, '梯度是导数在高维的推广'],
    ['integral', 'ode', 0.48, '解微分方程要靠积分'],
    ['bayes', 'integral', 0.36, '概率密度靠积分累积'],
    ['taylor', 'grad', 0.42, '一阶泰勒展开就是局部线性化'],
    ['matrix', 'eigen', 0.78, '特征向量是变换下的不变量'],
    ['matrix', 'span', 0.62, '矩阵的列空间就是它张成的空间'],
    ['matrix', 'lsq', 0.6, '最小二乘用矩阵投影表达'],
    ['eigen', 'svd', 0.66, 'SVD 把特征分解推广到任意矩阵'],
    ['span', 'lsq', 0.45, '投影落到子空间里'],
    ['svd', 'span', 0.38, '奇异值刻画各个方向的伸缩'],
    ['newton', 'energy', 0.68, '受力分析之外的另一种解法'],
    ['energy', 'heat', 0.5, '热力学第一定律就是能量守恒'],
    ['shm', 'wave', 0.66, '振动是波动的单个振元'],
    ['induction', 'wave', 0.45, '变化的电磁场以波的形式传播'],
    ['energy', 'induction', 0.32, '能量在电磁系统里的转化'],
    ['gd', 'nn', 0.86, '神经网络靠梯度下降训练'],
    ['nn', 'cnn', 0.7, 'CNN 是带结构先验的网络'],
    ['nn', 'overfit', 0.62, '参数越多越要警惕过拟合'],
    ['bigo', 'graph', 0.4, '图算法的代价用复杂度衡量'],
    ['infent', 'overfit', 0.38, '交叉熵是分类网络最常用的损失'],
    ['gd', 'overfit', 0.34, '训练早停是一种隐式正则'],
    ['wrongbook', 'review', 0.74, '错题要按记忆曲线安排重做'],
    ['wrongbook', 'ocr', 0.55, '拍照入库依赖公式识别'],
    ['wrongbook', 'pitch', 0.34, '错题本是答辩里最实的证据'],
    ['caption', 'sync', 0.4, '字幕与笔记要在多端同步'],
    ['ocr', 'pitch', 0.3, '识别精度是可以被讲清楚的技术指标'],
    ['ebbing', 'spacing', 0.8, '间隔重复是对遗忘曲线的回答'],
    ['spacing', 'retrieval', 0.7, '间隔里最重要的事是主动提取'],
    ['retrieval', 'transfer', 0.55, '提取练习促进迁移'],
    ['load', 'transfer', 0.38, '降低负荷才有余力做抽象'],
    ['load', 'retrieval', 0.32, '主动提取把负荷从读转向想'],

    /* —— 跨域突触 —— */
    ['grad', 'gd', 0.86, '梯度的反方向，就是下降的方向'],
    ['grad', 'lsq', 0.56, '令梯度为零，就得到最小二乘的正规方程'],
    ['taylor', 'lsq', 0.4, '一个做局部近似，一个做全局拟合'],
    ['matrix', 'nn', 0.72, '神经网络的每一层都是一次矩阵乘法'],
    ['eigen', 'shm', 0.62, '特征频率就是系统的固有模态'],
    ['fourier', 'shm', 0.74, '傅里叶把振动拆成一族正弦'],
    ['wave', 'fourier', 0.7, '叠加与频域，是同一件事的两面'],
    ['lsq', 'overfit', 0.52, '拟合得刚好，才有泛化'],
    ['taylor', 'nn', 0.38, '反向传播的每一步都在做局部线性化'],
    ['svd', 'cnn', 0.45, '卷积核可以看作一组可学习的基'],
    ['bayes', 'wrongbook', 0.55, '用后验更新下一个该推荐的知识点'],
    ['bayes', 'overfit', 0.5, '先验的作用，很像正则化'],
    ['infent', 'heat', 0.82, '同一个「熵」：一个描述信息，一个描述热'],
    ['infent', 'caption', 0.42, '语音编码同样受信息熵约束'],
    ['graph', 'wrongbook', 0.68, '知识点之间，本来就是一张图'],
    ['graph', 'sync', 0.35, '冲突合并要在图上找一致子集'],
    ['ode', 'ebbing', 0.6, '遗忘曲线正是一条指数衰减'],
    ['ode', 'energy', 0.42, '守恒量能让微分方程降阶'],
    ['retrieval', 'wrongbook', 0.6, '重做错题，就是一次检索练习'],
    ['spacing', 'review', 0.72, '复习计划就是间隔重复的工程化'],
    ['transfer', 'pitch', 0.35, '把技术迁移成评委听得懂的故事'],
    ['load', 'infent', 0.4, '工作记忆的容量，近似一次能处理的信息量'],
    ['cnn', 'ocr', 0.66, '公式识别本质是图像特征提取'],
    ['bigo', 'sync', 0.3, '合并算法的复杂度决定同步体验'],
    ['fourier', 'caption', 0.52, '降噪放到频域里做最直接']
  ];

  const COACT = [
    ['review', 'ebbing', 0.22, '共激活：做复习计划时反复回到遗忘曲线'],
    ['sync', 'graph', 0.16, '共激活：同步冲突用图算法想过一次']
  ];

  function create(now) {
    now = now || Date.now();
    const nodes = [];
    const byKey = {};

    for (const row of NODES) {
      const [key, title, domain, summary, tags, importance, ageDays, rc] = row;
      const init = 8 + 22 * importance;
      const stability = Math.min(900, init * Math.pow(1.62, rc));
      const createdAge = rc > 0 ? ageDays + 28 + rc * 9 : ageDays;
      const node = {
        id: 'n_' + key,
        title,
        summary,
        domain,
        tags,
        importance,
        stability,
        recallCount: rc,
        createdAt: now - createdAge * DAY,
        lastRecalledAt: now - ageDays * DAY
      };
      nodes.push(node);
      byKey[key] = node;
    }

    const synapses = [];
    for (const [ka, kb, weight, reason] of LINKS) {
      const a = byKey[ka], b = byKey[kb];
      if (!a || !b) continue;
      const cross = a.domain !== b.domain;
      const last = Math.max(a.lastRecalledAt, b.lastRecalledAt);
      synapses.push({
        id: 's_' + ka + '_' + kb,
        source: a.id,
        target: b.id,
        kind: cross ? 'bridge' : 'assoc',
        weight,
        reason,
        createdAt: Math.min(a.createdAt, b.createdAt) + HU.DAY,
        lastActive: last,
        coactivations: 0,
        nascent: false
      });
    }
    for (const [ka, kb, weight, reason] of COACT) {
      const a = byKey[ka], b = byKey[kb];
      if (!a || !b) continue;
      synapses.push({
        id: 's_co_' + ka + '_' + kb,
        source: a.id,
        target: b.id,
        kind: 'coact',
        weight,
        reason,
        createdAt: now - 3 * DAY,
        lastActive: now - 2 * DAY,
        coactivations: 1,
        nascent: true
      });
    }

    return {
      version: 2,
      createdAt: now,
      updatedAt: now,
      domains: DOMAINS.map((d) => Object.assign({}, d)),
      nodes,
      synapses,
      settings: { threshold: 0.32, showDormant: false },
      meta: { seeded: true }
    };
  }

  global.Seed = { create, DOMAINS };
})(typeof window !== 'undefined' ? window : globalThis);

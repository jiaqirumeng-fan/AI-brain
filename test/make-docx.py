import sys
from docx import Document

doc = Document()
doc.add_heading('机器学习与梯度下降', 0)
doc.add_paragraph('梯度下降沿损失函数梯度的反方向迭代，学习率决定每一步的大小。')
doc.add_heading('反向传播', 1)
doc.add_paragraph('反向传播用链式法则把误差分摊回每一层参数，是神经网络训练的基础。')
doc.add_heading('过拟合', 1)
doc.add_paragraph('模型在训练集上越来越好，在未见数据上变差；正则化与更多数据是对策。')
doc.save(sys.argv[1])

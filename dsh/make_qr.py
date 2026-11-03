#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate a pairing QR code as SVG.

Usage: python make_qr.py <url> <output.svg>
"""
import sys

import qrcode
import qrcode.image.svg


def main():
    if len(sys.argv) < 3:
        print('usage: make_qr.py <url> <output.svg>', file=sys.stderr)
        return 2
    url, output = sys.argv[1], sys.argv[2]
    image = qrcode.make(
        url,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=10,
        border=2,
    )
    image.save(output)
    return 0


if __name__ == '__main__':
    sys.exit(main())

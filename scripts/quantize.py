#!/usr/bin/env python3
"""
@file quantize.py
@description Converts FP32 YOLOv8 ONNX models to INT8 using ONNX Runtime Dynamic Quantization.
Optimized for ARM Cortex-A53 / Amlogic S905X STB deployment (reduces model size ~75% and CPU load ~50%).

Usage:
    python scripts/quantize.py --input models/yolov8n.onnx --output models/yolov8n_int8.onnx
"""

import os
import sys
import argparse

def quantize_model(input_path: str, output_path: str, weight_type_str: str = "QUInt8"):
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
    except ImportError as e:
        print(f"\n[ERROR] Required Python packages are missing: {e}")
        print("Install them with: pip install onnx onnxruntime\n")
        sys.exit(1)

    if not os.path.exists(input_path):
        print(f"\n[ERROR] Input model not found at: {input_path}")
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    weight_type = QuantType.QUInt8 if weight_type_str.upper() == "QUINT8" else QuantType.QInt8

    initial_size_mb = os.path.getsize(input_path) / (1024 * 1024)
    print(f"\n==========================================")
    print(f"  NYX NVR - Model INT8 Quantizer")
    print(f"==========================================")
    print(f"Input model   : {input_path} ({initial_size_mb:.2f} MB)")
    print(f"Output model  : {output_path}")
    print(f"Weight type   : {weight_type_str}")
    print(f"Target CPU    : ARM Cortex-A53 / x86_64")
    print(f"Quantizing model... Please wait...")

    try:
        quantize_dynamic(
            model_input=input_path,
            model_output=output_path,
            weight_type=weight_type,
            per_channel=False,
            reduce_range=False
        )

        final_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        compression = (1 - (final_size_mb / initial_size_mb)) * 100

        print(f"\n[SUCCESS] Model successfully quantized!")
        print(f"Original size : {initial_size_mb:.2f} MB")
        print(f"INT8 size     : {final_size_mb:.2f} MB ({compression:.1f}% reduction)")
        print(f"Saved to      : {output_path}")
        print(f"==========================================\n")
    except Exception as e:
        print(f"\n[ERROR] Failed to quantize model: {e}")
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Quantize YOLOv8 ONNX model to INT8 for NYX NVR")
    parser.add_argument("--input", "-i", type=str, default="models/yolov8n.onnx", help="Path to input FP32 ONNX model")
    parser.add_argument("--output", "-o", type=str, default="models/yolov8n_int8.onnx", help="Path to output INT8 ONNX model")
    parser.add_argument("--type", "-t", type=str, default="QUInt8", choices=["QUInt8", "QInt8"], help="Quantization weight type")
    
    args = parser.parse_args()
    quantize_model(args.input, args.output, args.type)

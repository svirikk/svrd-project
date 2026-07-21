#pragma once

#include <vector>
#include "StringArtImage.h"
#include "Point2D.h"

class StringArtist
{
public:
    StringArtist(const Image& image, unsigned int numPins, float draftOpacity, float threshold, unsigned int skippedNeighbors, unsigned int scaleFactor, unsigned int minSteps, unsigned int maxSteps);
    ~StringArtist(){};
    void windString();
    bool findNextPin(const size_t currentPinId, size_t& bestPinId, float& bestScore) const;
    float lineScore(const size_t currentPinId, const size_t nextPinId, unsigned int& pixelChanged) const;
    void drawLine(StringArtImage& image, const size_t currentPinId, const size_t nextPinId, const float opacity=1.0f, const unsigned int brushRadius=0);
    void saveImage(std::FILE* outputFile);
private:
    const Image* m_imagePtr;
    StringArtImage m_canvas;
    StringArtImage m_draft;
    std::vector<std::vector<bool>> m_adjacency;
    size_t m_numPins;
    float m_draftOpacity;
    float m_threshold;
    unsigned int m_skippedNeighbors;
    unsigned int m_scaleFactor;
    unsigned int m_iteration;

    unsigned int m_minSteps;              // не зупинятись раніше цього — навіть якщо лінії вже не дуже допомагають
    unsigned int m_maxSteps;              // жорсткий стеля — фізична межа того, скільки ниток можна сплести
    double m_totalDistancePixels = 0.0;  // сумарна довжина в пікселях
    std::vector<size_t> m_pinSequence;    // повна послідовність пінів (для застосунку складання)
};
